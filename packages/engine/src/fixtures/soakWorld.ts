/**
 * The soak world and its invariant sweep (tasks E07/L06, docs/07 §§4, 6).
 *
 * docs/07 §6 asks for two soaks: 100 000 ticks routinely in development, and
 * 1 000 000 ticks nightly or manually before release. Both must check the same
 * six things — no invalid numbers, no count corruption, no ID collision, no
 * dead-entity leak, snapshots that still round-trip, and a repeatable hash —
 * on the same world, or the long one is not the short one at scale.
 *
 * That is why this module exists rather than a second copy of the checks inside
 * `scripts/`: the 100 000-tick Vitest soak and the 1 000 000-tick CLI soak share
 * one world definition and one invariant sweep, so a rule added to either is
 * added to both.
 *
 * ## Why a smaller world than DEFAULT_CONFIG
 *
 * The reference world's carrying capacity is far above the 8 192 organism safety
 * cap (ADR 0006 §7), so a long run there spends most of its length at ~8 000
 * organisms and costs hours — a soak nobody would run. This world is 96x96 with
 * 64 founders: the same biology, the same phases, the same config in every
 * ecological respect, at a population the world can actually feed.
 *
 * That is not a weaker subject for what a soak measures. It boom-crashes
 * repeatedly — the population swings between roughly 100 and 2 800 — which
 * recycles slots far harder than a population pinned at a cap, and it reaches
 * deeper generations per tick of compute. The reference world's determinism is
 * pinned separately by the mandated 10 000-tick golden fixture.
 *
 * A 64x64 variant was measured first and rejected: it goes extinct around tick
 * 25 000, after which a soak silently stops testing anything.
 */
import { NEURAL_WEIGHT_COUNT } from "../brain/NeuralTopology";
import { createFounderBrainWeights } from "../brain/founderBrain";
import { cloneConfig, type ReadonlySimulationConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { engineInternals } from "../internal";
import { POS_SCALE, Q } from "../math/fixed";
import { DEATH_CAUSE_COUNT } from "../organisms/death";
import { bodyMass, currentRadiusPos, maxEnergyForOrganism } from "../organisms/phenotype";
import type { SimulationEngine } from "../SimulationEngine";
import { Biome } from "../world/biomes";
import { totalPlantBiomass, totalPlantCapacity } from "../world/plants";

export const SOAK_GRID_SIZE = 144;
export const SOAK_FOUNDERS = 96;
export const SOAK_SEED = 0xe0a12026;

/**
 * The soak world: DEFAULT_CONFIG biology on a 2 304 LU map.
 *
 * Only geometry, founder count and the world-validity thresholds that scale with
 * area are changed. Every organism, brain, mutation, reproduction and plant
 * constant is DEFAULT_CONFIG's, because those are what the soak is checking.
 *
 * ## Why the map grew in engine 0.9.0 (ADR 0028 section 5)
 *
 * It was 96 cells and 64 founders until M14, and at that size the soak was a
 * coin flip rather than an instrument. Its population oscillates hard — peaks
 * near 2 400 against troughs near 50 — so whether anything was still alive at
 * tick 100 000 depended on the PRNG stream, and 0.9.0's stream lost the toss:
 * the old world goes extinct at ~tick 70 000, where 0.8.0 reported 766 alive.
 *
 * That was never an M14 regression. M14 adds no physical consequence at all
 * (that is M15), and the shipped ecology measured identical on a twelve-seed
 * sweep of DEFAULT_CONFIG. The same 96-cell fixture also survives on other
 * seeds, with troughs of 64 and 44 — which is the real finding: a world that
 * routinely dips to fifty individuals cannot be relied on to run 100 000 ticks
 * looking for pathologies, because it may spend the last third of them empty.
 *
 * 144 cells and 96 founders was chosen by measurement: it survives 100 000
 * ticks on the fixture seed and on three alternates. No DEFAULT_CONFIG value
 * was touched — the soak still soaks the shipped biology — and no assertion in
 * `soak.test.ts` was weakened. Known limitation, deliberately recorded rather
 * than tuned away: one of the four measured seeds bottomed out at 6 live
 * organisms, so this is more headroom, not proof against a future stream.
 */
export const SOAK_CONFIG: ReadonlySimulationConfig = (() => {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.envGridSize = SOAK_GRID_SIZE;
  config.world.sizeLU = SOAK_GRID_SIZE * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(SOAK_GRID_SIZE / 8));
  config.world.initialOrganisms = SOAK_FOUNDERS;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  // Both thresholds are absolute counts calibrated for the 256x256 reference
  // world; scaled by area they keep the same meaning here.
  config.world.validity.minFounderRegionCells = Math.floor((SOAK_GRID_SIZE * SOAK_GRID_SIZE) / 8);
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity / 16,
  );
  return config;
})();

/**
 * Ticks the golden soak hash below is stamped at.
 *
 * The 100 000-tick Vitest soak asserts it; the 1 000 000-tick CLI soak checks it
 * in passing at the same tick, which is what makes the two runs provably the
 * same run at two lengths rather than two similar ones.
 */
export const SOAK_GOLDEN_TICKS = 100_000;

/**
 * State hash of the soak world after {@link SOAK_GOLDEN_TICKS} ticks.
 *
 * Regenerate together with the golden fixture whenever ENGINE_VERSION changes.
 *
 * Engine 0.7.0 moved it with no ecological change: the founder region and the
 * (empty) command log joined the canonical stream, event payloads became
 * signed 32-bit words, and the config digest gained the interventions section.
 * No command ever runs in this world — the population trajectory is unchanged
 * from 0.6.0, exactly as 0.6.0's was from 0.5.0. Notable, still: 100 000 ticks
 * of real evolution end with ONE species — the evolved diversity is a
 * continuous cloud, and the detector correctly refuses to split a cloud
 * (docs/05 §7); the synthetic split fixtures prove the other direction.
 *
 * Engine 0.9.0 moved it twice over (ADR 0028): the morphological genome joined
 * the canonical hash stream and the PRNG stream, AND the soak map grew from 96
 * cells / 64 founders to 144 / 96 so that the soak stops being a coin flip
 * (see the SOAK_CONFIG note above). The enlarged world finishes 100 000 ticks
 * with 674 alive, one species and 8 timeline events, in 557 s.
 *
 * Engine 0.8.0 moved it with three intentional ecological changes (ADR 0025):
 * the expected-gain food-target rule, the 0.6x plant-capacity calibration and
 * carcass decay 20 -> 48. The soak world inherits all three through
 * DEFAULT_CONFIG, deliberately — it exists to soak the shipped biology, and
 * the leaner, scavenging trajectory (population 766 at tick 100 000, still
 * one species) is the shipped biology now. The undivided world continuing to
 * refuse a split remains the detector's negative control; the ecological
 * POSITIVE control is the fixtures/speciationScenario.ts world, whose
 * channel-fragmented run splits at ~tick 45 000.
 *
 * Engine 0.11.0 moved it again (M16, ADR 0030): the topology genome and the
 * authoritative neural state join the canonical stream, the weight block grows
 * 400 -> 576, structural mutation adds draws at every birth, and brain upkeep
 * bills any lineage that grows a network. The soak world inherits all of it
 * through DEFAULT_CONFIG, deliberately, and finishes 100 000 ticks with 572
 * alive, one species and 3 timeline events in 1137 s. The undivided world
 * still refuses to split, which is the point of it.
 */
export const GOLDEN_SOAK_HASH = "a134ed2ffa600843";

/** Every way a sweep can find the world broken. All zero means healthy. */
export interface SoakViolations {
  /** A live slot with the invalid entity ID 0, or an ID seen twice. */
  identity: number;
  /** A released slot that still holds data — a dead-entity leak. */
  leakedSlot: number;
  /** Energy negative, or above the maximum the body can hold. */
  energy: number;
  /** Health zero (should have died) or above Q. */
  health: number;
  /** Position outside the world, or development above full. */
  body: number;
  /** liveCount + freeCount must always equal slotHighWater. */
  bookkeeping: number;
  /** A child whose generation does not exceed a plausible bound, or a bad parent link. */
  lineage: number;
  /**
   * A carcass with no meat, no identity, a position outside the world, or an
   * active/free bookkeeping mismatch (docs/07 §4: "carcass meat >= 0").
   *
   * Carrion is authoritative state that is created, eaten and decayed by three
   * different phases, so it gets the same per-sweep audit the organisms get.
   */
  carcass: number;
  /**
   * A live organism assigned to a missing or ended species, a registry
   * population that does not match its live members (docs/07 §4 "species
   * population matches members"), or a parent link that does not point at an
   * older species (the acyclicity invariant, docs/05 §19). Milestone 8.
   */
  species: number;
  /**
   * Plant biomass above capacity or below zero, a growth remainder outside its
   * range, or vegetation standing in water (docs/07 §4 environment invariants).
   */
  environment: number;
}

export const NO_SOAK_VIOLATIONS: SoakViolations = Object.freeze({
  identity: 0,
  leakedSlot: 0,
  energy: 0,
  health: 0,
  body: 0,
  bookkeeping: 0,
  lineage: 0,
  carcass: 0,
  species: 0,
  environment: 0,
});

/** Full organism invariant sweep (docs/07 §4 development invariants). */
function checkOrganisms(engine: SimulationEngine, seenIds: Set<number>, v: SoakViolations): void {
  const { organisms, config } = engine;
  // The phenotype cache is engine-internal (it is derived state, not part of the
  // public surface), and the energy bound needs the adult radius it holds.
  const { phenotypes, physical } = engineInternals(engine).context;
  const maxPos = config.world.sizeLU * POS_SCALE - 1;

  seenIds.clear();
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      // docs/07 §4: a free slot must be fully cleared, or the state hash would
      // depend on the history of the dead.
      if (
        (organisms.entityId[slot] as number) !== 0 ||
        (organisms.energy[slot] as number) !== 0 ||
        (organisms.generation[slot] as number) !== 0 ||
        (organisms.reproductionCooldown[slot] as number) !== 0
      ) {
        v.leakedSlot += 1;
      }
      continue;
    }

    const id = organisms.entityId[slot] as number;
    if (id === 0 || id >= organisms.nextEntityId || seenIds.has(id)) {
      v.identity += 1;
    }
    seenIds.add(id);

    const energy = organisms.energy[slot] as number;
    const mass = bodyMass(
      physical,
      slot,
      currentRadiusPos(
        phenotypes.adultRadiusPos[slot] as number,
        organisms.developmentQ[slot] as number,
      ),
      config.organism.massScalePerRadiusSquared,
    );
    // The upper bound is the one a birth could break: a child endowed with its
    // parent's investment must never be granted more than its own body holds.
    if (
      !Number.isSafeInteger(energy) ||
      energy < 0 ||
      energy > maxEnergyForOrganism(physical, slot, mass, config)
    ) {
      v.energy += 1;
    }

    const health = organisms.healthQ[slot] as number;
    if (health === 0 || health > Q) {
      v.health += 1;
    }

    const x = organisms.x[slot] as number;
    const y = organisms.y[slot] as number;
    if (x < 0 || y < 0 || x > maxPos || y > maxPos) {
      v.body += 1;
    }
    if ((organisms.developmentQ[slot] as number) > Q) {
      v.body += 1;
    }

    const parent = organisms.parentEntityId[slot] as number;
    const generation = organisms.generation[slot] as number;
    // Generation 0 is a founder and has no parent; anything else must name a
    // parent whose ID was issued before its own.
    if (generation === 0 ? parent !== 0 : parent === 0 || parent >= id) {
      v.lineage += 1;
    }
  }

  if (organisms.liveCount + organisms.freeCount !== organisms.slotHighWater) {
    v.bookkeeping += 1;
  }
  if (organisms.liveCount !== seenIds.size) {
    v.bookkeeping += 1;
  }
  if (organisms.totalBirths - organisms.totalDeaths !== organisms.liveCount) {
    v.bookkeeping += 1;
  }
}

/** Species registry invariant sweep (docs/07 §4, Milestone 8). */
function countSpeciesViolations(engine: SimulationEngine): number {
  const { organisms, species } = engine;
  let violations = 0;

  // Live member count per species, from the population itself.
  const liveMembers = new Map<number, number>();
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    const id = organisms.speciesId[slot] as number;
    if (id < 1 || id > species.count) {
      violations += 1;
      continue;
    }
    liveMembers.set(id, (liveMembers.get(id) ?? 0) + 1);
  }

  let activeSeen = 0;
  for (const record of species.records) {
    const live = liveMembers.get(record.id) ?? 0;
    // docs/07 §4: species population matches members, live or ended.
    if (record.population !== live) violations += 1;
    if (record.endReason === 0) {
      activeSeen += 1;
    } else if (live !== 0 || record.endTick === 0) {
      // An ended species may not have members, and must know when it ended.
      violations += 1;
    }
    // Parents strictly precede children: the Tree of Life stays acyclic.
    if (record.id === 1 ? record.parentSpeciesId !== 0 : record.parentSpeciesId >= record.id) {
      violations += 1;
    }
    if (record.parentSpeciesId < 0 || record.parentSpeciesId > species.count) violations += 1;
  }
  if (activeSeen !== species.activeCount) violations += 1;

  return violations;
}

/** Carcass invariant sweep (docs/07 §4, Milestone 5). */
function countCarcassViolations(engine: SimulationEngine): number {
  const { carcasses, config } = engine;
  const maxPos = config.world.sizeLU * POS_SCALE - 1;
  let violations = 0;
  let active = 0;

  for (let slot = 0; slot < carcasses.slotHighWater; slot += 1) {
    if (carcasses.active[slot] !== 1) {
      // A released row must be blank, or the state hash would depend on the
      // history of carcasses that no longer exist.
      if (
        (carcasses.entityId[slot] as number) !== 0 ||
        (carcasses.remainingMeat[slot] as number) !== 0
      ) {
        violations += 1;
      }
      continue;
    }
    active += 1;
    // An active carcass with no meat left should have been released by the phase
    // that emptied it, whether that was feeding or decay.
    if ((carcasses.remainingMeat[slot] as number) <= 0) violations += 1;
    if ((carcasses.entityId[slot] as number) === 0) violations += 1;
    const x = carcasses.x[slot] as number;
    const y = carcasses.y[slot] as number;
    if (x < 0 || y < 0 || x > maxPos || y > maxPos) violations += 1;
  }

  if (active !== carcasses.liveCount) violations += 1;
  if (carcasses.liveCount + carcasses.freeCount !== carcasses.slotHighWater) violations += 1;
  // The conservation identity, checked on every sweep rather than once at the end.
  if (
    carcasses.totalMeatEaten + carcasses.totalMeatDecayed + carcasses.totalRemainingMeat() !==
    carcasses.totalMeatCreated
  ) {
    violations += 1;
  }
  return violations;
}

/**
 * Environment invariant sweep (docs/07 §4, carried over from the Milestone 2
 * environment soak).
 *
 * Cheap relative to the organism sweep — one pass over the grid, which is 9 216
 * cells here against up to 8 192 organism slots — so the long soak runs it on
 * every sweep rather than once at the end. A world that overfilled a cell at
 * tick 400 000 and drained it again by the end would otherwise pass.
 */
function countEnvironmentViolations(engine: SimulationEngine): number {
  const { environment } = engine;
  let violations = 0;
  for (let i = 0; i < environment.cellCount; i += 1) {
    const biomass = environment.plantBiomass[i] as number;
    if (biomass > (environment.plantCapacity[i] as number)) violations += 1;
    if (biomass < 0) violations += 1;
    if ((environment.plantGrowthRemainderQ[i] as number) >= Q) violations += 1;
    if (environment.biome[i] === Biome.Water && biomass !== 0) violations += 1;
  }
  const total = totalPlantBiomass(environment);
  if (total < 0 || total > totalPlantCapacity(environment)) violations += 1;
  return violations;
}

/**
 * One full invariant sweep over a soak world.
 *
 * `seenIds` is passed in and reused so a sweep every ~1 000 ticks over a million
 * of them does not allocate a fresh Set each time.
 */
export function checkSoakInvariants(
  engine: SimulationEngine,
  seenIds: Set<number>,
): SoakViolations {
  const violations: SoakViolations = {
    identity: 0,
    leakedSlot: 0,
    energy: 0,
    health: 0,
    body: 0,
    bookkeeping: 0,
    lineage: 0,
    carcass: 0,
    species: 0,
    environment: 0,
  };
  checkOrganisms(engine, seenIds, violations);
  violations.carcass = countCarcassViolations(engine);
  violations.species = countSpeciesViolations(engine);
  violations.environment = countEnvironmentViolations(engine);
  return violations;
}

/** True when a sweep found nothing wrong. */
export function soakIsHealthy(violations: SoakViolations): boolean {
  return Object.values(violations).every((count) => count === 0);
}

/**
 * How far a population's brains have drifted from the founder controller
 * (docs/07 §12 "mutation destroys brain too fast").
 *
 * Cosine similarity against the founder weight vector: 1.0 is the founder brain,
 * 0.0 an unrelated one. An unrelated 400-dimensional brain scores about
 * 1/sqrt(400) = 0.05, which is the noise floor any threshold must clear.
 * `clampedFraction` is the other half of the failure mode — weights piling onto
 * the clamp mean the mutation sigma is saturating brains rather than exploring
 * with them.
 */
export function measureBrainDrift(engine: SimulationEngine): {
  meanSimilarity: number;
  brainsMeasured: number;
  clampedFraction: number;
} {
  const { organisms, genomes, config } = engine;
  const founderBrain = createFounderBrainWeights(
    config.brain.weightScale,
    config.brain.weightMin,
    config.brain.weightMax,
  );
  let founderNormSq = 0;
  for (let i = 0; i < NEURAL_WEIGHT_COUNT; i += 1) {
    founderNormSq += (founderBrain[i] as number) ** 2;
  }

  let similaritySum = 0;
  let brainsMeasured = 0;
  let weightsAtClamp = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    const base = genomes.weightOffset(slot);
    let dot = 0;
    let normSq = 0;
    for (let i = 0; i < NEURAL_WEIGHT_COUNT; i += 1) {
      const weight = genomes.brainWeights[base + i] as number;
      dot += weight * (founderBrain[i] as number);
      normSq += weight * weight;
      if (weight === config.brain.weightMin || weight === config.brain.weightMax) {
        weightsAtClamp += 1;
      }
    }
    similaritySum += normSq > 0 ? dot / Math.sqrt(normSq * founderNormSq) : 0;
    brainsMeasured += 1;
  }

  return {
    meanSimilarity: brainsMeasured > 0 ? similaritySum / brainsMeasured : 0,
    brainsMeasured,
    clampedFraction:
      brainsMeasured > 0 ? weightsAtClamp / (brainsMeasured * NEURAL_WEIGHT_COUNT) : 0,
  };
}

/** Deaths summed over the cause histogram; must equal `totalDeaths`. */
export function deathsByCauseTotal(engine: SimulationEngine): number {
  let total = 0;
  for (let cause = 0; cause < DEATH_CAUSE_COUNT; cause += 1) {
    total += engine.organisms.deathsByCause[cause] as number;
  }
  return total;
}
