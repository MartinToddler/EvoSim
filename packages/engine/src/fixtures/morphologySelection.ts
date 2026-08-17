import { cloneConfig, type ReadonlySimulationConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { Gene, geneToQ, hueDegrees } from "../genetics/genes";
import { engineInternals } from "../internal";
import { Q, qmul } from "../math/fixed";
import { createFounderMorphGenes } from "../morphology/founderMorphGenome";
import { MorphologyStore, deriveMorphology } from "../morphology/morphDevelopment";
import { MorphGene, morphGeneFromQ } from "../morphology/morphGenes";
import {
  computeMorphologyExpressions,
  createMorphologyExpressions,
  createMorphologyReference,
  derivePhysical,
} from "../morphology/physicalPhenotype";
import { GenomeStore } from "../organisms/GenomeStore";
import {
  bodyMass,
  currentRadiusPos,
  derivePhenotype,
  maxEnergyForOrganism,
} from "../organisms/phenotype";
import type { SimulationEngine } from "../SimulationEngine";

/**
 * Two controlled selection environments for functional morphology
 * (M15, docs/11 §M15, ADR 0029).
 *
 * The acceptance criterion M15 has to meet is not "a handcrafted body reads
 * correctly in a fixture" — M14 already proved that much. It is that **ordinary
 * mutation, inheritance and realized survival move a population's body plan**,
 * and that two different worlds move it in *different directions*. Nothing here
 * assigns fitness, scores a body, spawns a shaped organism or touches a
 * morphological gene. Both scenarios are the shipped engine, the shipped
 * founder genome and the shipped mutation rates; the only thing that differs is
 * the world the founders are dropped into.
 *
 * ## The two worlds, and the mechanism each one leans on
 *
 * Both worlds hold the same total productivity and differ only in **how it is
 * distributed**, which is the oldest contrast in ecology and the one this engine
 * can express without a single new rule.
 *
 * **Turf.** Every land biome has the same thin plant capacity, and it grows back
 * almost as fast as it is eaten. Food is everywhere and a grazed cell is worth
 * grazing again, so there is nothing to travel for and nowhere better to be; the
 * binding constraint is what an organism spends merely existing. Limbs and a
 * tail are billed every tick whether or not they are used, so the body that eats
 * last and still reproduces is the cheap one.
 *
 * **Archipelago.** The same generator with the sea raised until land is
 * fragmented. Food is on the fragments, so an organism that never enters water
 * competes with its own descendants for the patch it was born on. Water is slow
 * to cross, expensive to cross and — past a shortened grace window — damaging,
 * and what carries a body across it is exactly the limb area and tail that the
 * turf makes a liability.
 *
 * Neither world is told any of that, and neither knows what a patch is. Both run
 * the shipped feeding, metabolism, movement and reproduction phases; the only
 * difference between them is which cells can hold biomass.
 *
 * ## What is measured, and why it is not the population mean
 *
 * Selection moves a population mean by `h^2 S` per generation, so tens of
 * generations of a one-percent differential is invisible next to drift in a
 * population of a few hundred — a first probe measured exactly that, sixty
 * generations of noise (ADR 0029 §5a). What these scenarios measure instead is
 * `S` itself: the difference between the mean body plan of the organisms that
 * **actually produced offspring** and the mean of the population they were drawn
 * from. It is one number per trait per world, backed by every birth in the run,
 * and it is measured rather than assigned — an organism enters the reproducer
 * mean because the ordinary reproduction phase gave it a child.
 *
 * ## Why the plant capacities are pinned
 *
 * Same reason as the speciation scenario: these worlds must stay the worlds
 * they were measured on when `DEFAULT_CONFIG`'s capacities are next retuned, or
 * the experiment silently becomes a different experiment.
 */

export const SELECTION_GRID_SIZE = 128;

/**
 * How long each scenario runs.
 *
 * Measured, not chosen. Both worlds separate from the 50/50 start within a few
 * thousand ticks and hold their direction thereafter (ADR 0029 §5c), so this is
 * set where the direction is established with headroom rather than where the
 * outcome is most extreme — a gate that waits for fixation would be measuring
 * how long a sweep takes rather than which way it goes.
 *
 * The cost is real and is accepted rather than optimised away: these are dense
 * worlds, and the cheaper alternatives all tilt the experiment. Compressing the
 * life history looks like it only speeds the clock up, and it does not — growth
 * to the 90% development gate is paid for out of intake, so a tenth of the
 * maturity age demands ten times the intake rate, and a measured probe at
 * maturity 60-220 drove every seed extinct without producing a single
 * generation of signal.
 */
export const SELECTION_HORIZON = 8_000;

/** Seeds the scenarios are run on. Stochastic outcomes need more than one. */
export const SELECTION_SEEDS: readonly number[] = [0xe0a12026, 0xe0a13f15, 0xe0a17cf3];

function scenarioBase(): ReturnType<typeof cloneConfig> {
  const config = cloneConfig(DEFAULT_CONFIG);
  const grid = SELECTION_GRID_SIZE;
  config.world.envGridSize = grid;
  config.world.sizeLU = grid * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(grid / 8));
  config.world.initialOrganisms = 96;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.limits.maxOrganisms = 4096;
  config.limits.maxCarcasses = 2048;
  // Validity thresholds are absolute totals calibrated for the 256² default
  // world, so they scale with the area or a valid small world is rejected for
  // being small.
  config.world.validity.minFounderRegionCells = Math.floor((grid * grid) / 24);
  config.world.validity.minTotalPlantCapacity = Math.floor(
    DEFAULT_CONFIG.world.validity.minTotalPlantCapacity / 16,
  );
  // Pinned so a later capacity retune cannot move these experiments.
  config.plants.baseCapacityByBiome = [0, 21600, 31200, 4200, 6000, 2400];

  // The life history is deliberately NOT compressed. Shortening maturity and
  // lifespan looks like it only speeds the clock up, and it does not: growth to
  // the 90% development gate has to be PAID FOR out of intake, so a tenth of the
  // maturity age demands ten times the intake rate. A measured probe at maturity
  // 60-220 / lifespan 300-1200 drove every archipelago seed extinct between tick
  // 10 000 and 20 000 without producing a single generation of morphological
  // signal. Generations are bought with ticks here, and that cost is stated
  // rather than optimised away (ADR 0029 §5).
  return config;
}

/**
 * Scenario A — turf: thin food everywhere that grows back, so upkeep is
 * everything and there is nothing to travel for.
 */
export const TURF_CONFIG: ReadonlySimulationConfig = (() => {
  const config = scenarioBase();
  config.plants.baseCapacityByBiome = [0, 5400, 5400, 5400, 5400, 5400];
  // Thin, but it grows back almost as fast as it is eaten, so a cell an
  // organism has just grazed is worth grazing again. Standing still is a
  // viable living here, and what it costs to stand still is upkeep.
  config.plants.growthRateQByBiome = [0, 700, 700, 700, 700, 700];
  return config;
})();

/**
 * Scenario B — an archipelago: land is fragmented and water is everywhere.
 */
export const ARCHIPELAGO_CONFIG: ReadonlySimulationConfig = (() => {
  const config = scenarioBase();
  // The ordinary generator, run with the sea raised until land is fragmented.
  // The land-fraction window opens downward so a flooded world is accepted
  // rather than retried until a continent turns up.
  config.world.seaLevelQ = 2400;
  config.world.minLandFractionQ = 512; // 0.125
  config.world.maxLandFractionQ = 1638; // 0.40
  config.plants.baseCapacityByBiome = [0, 27000, 27000, 5400, 7600, 3000];
  config.plants.growthRateQByBiome = [0, 300, 300, 300, 300, 300];
  // A shorter grace window makes a slow crossing genuinely dangerous rather
  // than merely tedious. It is the same rule for everyone, applied to a world
  // where everyone has to cross.
  config.organism.movement.waterGraceTicks = Math.floor(
    DEFAULT_CONFIG.organism.movement.waterGraceTicks / 2,
  );
  return config;
})();

/**
 * Two body plans, each an ordinary point in the morphological genome space.
 *
 * They differ in **locomotor investment only** — appendage length and thickness
 * and tail length — and are identical in every other locus. That is deliberate:
 * an axis where both ends can win is the only kind that can demonstrate two
 * environments selecting in different directions, and the first pair tried here
 * did not have that property. See ADR 0029 §5b.
 *
 * These are not archetypes and the engine has no idea they exist: they are two
 * genomes, reachable from the founder by ordinary mutation, that sit far apart
 * on the axis the two worlds contest. Seeding a founder population with both is
 * what gives a selection experiment its power — selection sorts **standing
 * variation**, and a population founded on one genome has none until mutation
 * supplies it, which takes the hundreds of generations a first probe showed were
 * out of reach (ADR 0029 §5a).
 *
 * Nothing about either morph is privileged. Both are spawned as ordinary
 * organisms with identical ecological genes and identical brains, each endowed
 * with the same FRACTION of its own body's maximum energy, and from tick 1 the
 * engine treats them as it treats anything else.
 */
export const MOBILE_MORPH: Readonly<Partial<Record<MorphGene, number>>> = {
  [MorphGene.AppendageLength]: 3686, // 0.90 — long limbs
  [MorphGene.AppendageThickness]: 3277, // 0.80 — and thick ones
  [MorphGene.TailLength]: 3277,
};

export const SEDENTARY_MORPH: Readonly<Partial<Record<MorphGene, number>>> = {
  [MorphGene.AppendageLength]: 205, // 0.05 — stubs
  [MorphGene.AppendageThickness]: 205,
  [MorphGene.TailLength]: 205,
};

/**
 * Give a freshly created world standing morphological variation.
 *
 * Alternate founders are rewritten to {@link HEAVY_MORPH} and
 * {@link LIGHT_MORPH} and their derived caches rebuilt through the ordinary
 * pipeline, so every organism is exactly what `spawnOrganism` would have
 * produced from that genome. Energy is re-endowed as the same fraction of each
 * body's own maximum, or the heavier morph would start with a bigger tank
 * purely because it was written second.
 *
 * This sets up variation. It does not set up an outcome: which morph's
 * descendants are still there at the end is decided by the ordinary feeding,
 * metabolism, movement and reproduction phases.
 */
export function seedMorphologicalVariation(engine: SimulationEngine): void {
  const { context } = engineInternals(engine);
  const { organisms, genomes, phenotypes, morphology, physical, config, morphologyReference } =
    context;

  let index = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    const morph = index % 2 === 0 ? MOBILE_MORPH : SEDENTARY_MORPH;
    index += 1;
    const base = genomes.morphOffset(slot);
    for (const [gene, valueQ] of Object.entries(morph)) {
      genomes.morphGenes[base + Number(gene)] = morphGeneFromQ(valueQ);
    }
    deriveMorphology(
      morphology,
      genomes,
      slot,
      hueDegrees(geneToQ(genomes.gene(slot, Gene.Hue))),
      config,
    );
    derivePhysical(physical, morphology, slot, morphologyReference, config);
    derivePhenotype(phenotypes, genomes, physical, slot, config);

    const mass = bodyMass(
      physical,
      slot,
      currentRadiusPos(
        phenotypes.adultRadiusPos[slot] as number,
        organisms.developmentQ[slot] as number,
      ),
      config.organism.massScalePerRadiusSquared,
    );
    organisms.energy[slot] = qmul(
      maxEnergyForOrganism(physical, slot, mass, config),
      config.organism.initialEnergyFractionQ,
    );
  }
}

/**
 * Where the living population sits between the two seeded morphs, in `[0, Q]`.
 *
 * 0 means every survivor is as sedentary as {@link SEDENTARY_MORPH}, Q as
 * mobile as {@link MOBILE_MORPH}, and the population starts at exactly half.
 * Measured on limb area as a share of the body, which is the axis the two
 * morphs are seeded apart on.
 */
export function mobileShareQ(
  engine: SimulationEngine,
  bounds: { sedentaryQ: number; mobileQ: number },
): number {
  const { context } = engineInternals(engine);
  const { organisms, morphology, config, morphologyReference } = context;
  const expressions = createMorphologyExpressions();
  let total = 0;
  let count = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    computeMorphologyExpressions(morphology, slot, morphologyReference, config, expressions);
    total += expressions.propulsionQ;
    count += 1;
  }
  if (count === 0) {
    return 0;
  }
  const mean = total / count;
  const span = Math.max(1, bounds.mobileQ - bounds.sedentaryQ);
  return Math.round(((mean - bounds.sedentaryQ) * Q) / span);
}

/** The limb share each seeded morph develops to, for {@link mobileShareQ}. */
export function morphLimbBounds(config: ReadonlySimulationConfig): {
  sedentaryQ: number;
  mobileQ: number;
} {
  const reference = createMorphologyReference(config);
  const genomes = new GenomeStore(2);
  const morphology = new MorphologyStore(2);
  const expressions = createMorphologyExpressions();
  const founder = createFounderMorphGenes(config.organism.morphology);
  const measured: number[] = [];
  for (const [slot, morph] of [MOBILE_MORPH, SEDENTARY_MORPH].entries()) {
    genomes.morphGenes.set(founder, genomes.morphOffset(slot));
    for (const [gene, valueQ] of Object.entries(morph)) {
      genomes.morphGenes[genomes.morphOffset(slot) + Number(gene)] = morphGeneFromQ(valueQ);
    }
    deriveMorphology(morphology, genomes, slot, 0, config);
    computeMorphologyExpressions(morphology, slot, reference, config, expressions);
    measured.push(expressions.propulsionQ);
  }
  return { mobileQ: measured[0] as number, sedentaryQ: measured[1] as number };
}

/**
 * What one scenario run measured.
 *
 * The load-bearing numbers are the two means. `population` is the mean body
 * plan of everything that lived; `reproducers` is the mean body plan of the
 * organisms that actually produced offspring, weighted by how many they
 * produced. Their difference is the **selection differential** — the `S` of
 * `R = h²S` — and it is measured, never assigned: an organism enters the
 * reproducer mean because the ordinary reproduction phase gave it a child, for
 * whatever combination of reasons the world supplied.
 *
 * A differential is far more powerful than watching the population mean drift
 * toward something. The mean moves by `h²S` per generation, so tens of
 * generations of a 1% differential is invisible next to drift in a population
 * of a few hundred; the differential itself is visible in one generation, over
 * as many samples as there were births.
 */
export interface SelectionOutcome {
  /** Live organisms at the end of the run. */
  finalPopulation: number;
  /** Deepest generation reached. */
  generation: number;
  /** Births observed, i.e. the sample size behind `reproducers`. */
  births: number;
  /** Mean body plan over every organism alive at every sample. */
  population: MorphologyMeans;
  /** Mean body plan of the organisms that produced those births. */
  reproducers: MorphologyMeans;
}

/** One mean body plan, in the same units the expressions and factors use. */
export interface MorphologyMeans {
  slendernessQ: number;
  propulsionQ: number;
  tailQ: number;
  girthQ: number;
  mouthQ: number;
  armorQ: number;
  basalFactorQ: number;
  massFactorQ: number;
  growthCostFactorQ: number;
  maxSpeedFactorQ: number;
  waterSpeedFactorQ: number;
  thermalToleranceFactorQ: number;
}

const MEAN_KEYS: readonly (keyof MorphologyMeans)[] = [
  "slendernessQ",
  "propulsionQ",
  "tailQ",
  "girthQ",
  "mouthQ",
  "armorQ",
  "basalFactorQ",
  "massFactorQ",
  "growthCostFactorQ",
  "maxSpeedFactorQ",
  "waterSpeedFactorQ",
  "thermalToleranceFactorQ",
];

/** Accumulator for one mean. */
interface MeanAccumulator {
  totals: number[];
  count: number;
}

function newAccumulator(): MeanAccumulator {
  return { totals: new Array<number>(MEAN_KEYS.length).fill(0), count: 0 };
}

function finish(accumulator: MeanAccumulator): MorphologyMeans {
  const out = {} as MorphologyMeans;
  for (let i = 0; i < MEAN_KEYS.length; i += 1) {
    const key = MEAN_KEYS[i] as keyof MorphologyMeans;
    out[key] = accumulator.count === 0 ? 0 : (accumulator.totals[i] as number) / accumulator.count;
  }
  return out;
}

/**
 * How often the population mean is sampled, in ticks.
 *
 * The reproducer mean is exact — every birth is observed — so this only has to
 * be dense enough that the population mean is not dominated by whatever the
 * population happened to be doing at one moment.
 */
export const SELECTION_SAMPLE_INTERVAL = 50;

/**
 * Run one scenario and measure who actually reproduced.
 *
 * The engine is stepped one tick at a time so that every birth can be
 * attributed while its parent is still alive. Nothing here writes to the
 * engine: the observer reads the same derived caches the simulation uses, and a
 * run with the observer attached produces the same state hash as one without.
 */
export function runSelectionScenario(engine: SimulationEngine, ticks: number): SelectionOutcome {
  const { context } = engineInternals(engine);
  const { organisms, morphology, physical, config, morphologyReference } = context;
  const expressions = createMorphologyExpressions();

  const populationMean = newAccumulator();
  const reproducerMean = newAccumulator();
  let births = 0;
  let generation = 0;

  const accumulate = (accumulator: MeanAccumulator, slot: number): void => {
    computeMorphologyExpressions(morphology, slot, morphologyReference, config, expressions);
    const values: readonly number[] = [
      expressions.slendernessQ,
      expressions.propulsionQ,
      expressions.tailQ,
      expressions.girthQ,
      expressions.mouthQ,
      expressions.armorQ,
      physical.basalFactorQ[slot] as number,
      physical.massFactorQ[slot] as number,
      physical.growthCostFactorQ[slot] as number,
      physical.maxSpeedFactorQ[slot] as number,
      physical.waterSpeedFactorQ[slot] as number,
      physical.thermalToleranceFactorQ[slot] as number,
    ];
    for (let i = 0; i < values.length; i += 1) {
      accumulator.totals[i] = (accumulator.totals[i] as number) + (values[i] as number);
    }
    accumulator.count += 1;
  };

  for (let tick = 0; tick < ticks; tick += 1) {
    engine.step();

    // Every organism born on this tick, credited to the parent that made it.
    // Age 0 is exact: `spawnOrganism` zeroes it and the physiology phase has
    // already run for everyone who existed before this tick.
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] !== 1 || (organisms.ageTicks[slot] as number) !== 0) {
        continue;
      }
      const parentId = organisms.parentEntityId[slot] as number;
      if (parentId === 0) {
        continue;
      }
      const parentSlot = organisms.findSlotByEntityId(parentId);
      if (parentSlot < 0 || organisms.alive[parentSlot] !== 1) {
        continue;
      }
      births += 1;
      accumulate(reproducerMean, parentSlot);
    }

    if (tick % SELECTION_SAMPLE_INTERVAL !== 0) {
      continue;
    }
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] !== 1) {
        continue;
      }
      generation = Math.max(generation, organisms.generation[slot] as number);
      accumulate(populationMean, slot);
    }
  }

  return {
    finalPopulation: organisms.liveCount,
    generation,
    births,
    population: finish(populationMean),
    reproducers: finish(reproducerMean),
  };
}

/**
 * The selection differential on one trait: how much the organisms that actually
 * reproduced differ from the population they were drawn from.
 */
export function differential(outcome: SelectionOutcome, key: keyof MorphologyMeans): number {
  return outcome.reproducers[key] - outcome.population[key];
}

/** What one scenario run measured about the population's body plan. */
export interface MorphologyOutcome {
  population: number;
  generation: number;
  /** Mean length-to-width ratio, normalized: the axis the two worlds contest. */
  slendernessQ: number;
  /** Mean limb area as a share of the body. */
  propulsionQ: number;
  /** Mean tail length against its range. */
  tailQ: number;
  /** Mean body width against its range. */
  girthQ: number;
  /** Mean of the physical factors the two worlds are expected to trade off. */
  waterSpeedFactorQ: number;
  thermalToleranceFactorQ: number;
  basalFactorQ: number;
  massFactorQ: number;
}

/** The founder body's outcome vector: the neutral point every run starts from. */
export const FOUNDER_OUTCOME: MorphologyOutcome = {
  population: 0,
  generation: 0,
  slendernessQ: 0,
  propulsionQ: 0,
  tailQ: 0,
  girthQ: 0,
  waterSpeedFactorQ: Q,
  thermalToleranceFactorQ: Q,
  basalFactorQ: Q,
  massFactorQ: Q,
};

/**
 * Measure the living population's mean body plan.
 *
 * Read-only, and read from the same derived caches the simulation itself uses,
 * so this reports what the organisms actually are rather than re-deriving a
 * second opinion about them.
 */
export function measureMorphology(engine: SimulationEngine): MorphologyOutcome {
  const { context } = engineInternals(engine);
  const { organisms, morphology, physical, config, morphologyReference } = context;
  const expressions = createMorphologyExpressions();

  let count = 0;
  let generation = 0;
  let slenderness = 0;
  let propulsion = 0;
  let tail = 0;
  let girth = 0;
  let waterSpeed = 0;
  let thermalTolerance = 0;
  let basal = 0;
  let mass = 0;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    computeMorphologyExpressions(morphology, slot, morphologyReference, config, expressions);
    count += 1;
    generation = Math.max(generation, organisms.generation[slot] as number);
    slenderness += expressions.slendernessQ;
    propulsion += expressions.propulsionQ;
    tail += expressions.tailQ;
    girth += expressions.girthQ;
    waterSpeed += physical.waterSpeedFactorQ[slot] as number;
    thermalTolerance += physical.thermalToleranceFactorQ[slot] as number;
    basal += physical.basalFactorQ[slot] as number;
    mass += physical.massFactorQ[slot] as number;
  }

  const mean = (total: number): number => (count === 0 ? 0 : Math.round(total / count));
  return {
    population: count,
    generation,
    slendernessQ: mean(slenderness),
    propulsionQ: mean(propulsion),
    tailQ: mean(tail),
    girthQ: mean(girth),
    waterSpeedFactorQ: mean(waterSpeed),
    thermalToleranceFactorQ: mean(thermalTolerance),
    basalFactorQ: mean(basal),
    massFactorQ: mean(mass),
  };
}
