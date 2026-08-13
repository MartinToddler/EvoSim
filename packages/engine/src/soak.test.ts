import { describe, expect, it } from "vitest";
import { SimulationEngine } from "./SimulationEngine";
import { BRAIN_WEIGHT_COUNT } from "./brain/BrainLayout";
import { createFounderBrainWeights } from "./brain/founderBrain";
import { cloneConfig, type ReadonlySimulationConfig } from "./config/cloneConfig";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import { engineInternals } from "./internal";
import { POS_SCALE, Q } from "./math/fixed";
import { DEATH_CAUSE_COUNT } from "./organisms/death";
import { currentRadiusPos, massFromRadiusPos, maxEnergyForMass } from "./organisms/phenotype";
import { engineFromSnapshot } from "./snapshot/deserialize";
import { Biome } from "./world/biomes";
import { totalPlantBiomass, totalPlantCapacity } from "./world/plants";

/**
 * 100 000-tick evolutionary soak (task E07; docs/07 §6, Milestone 4 acceptance
 * "multiple generations; 100k soak; deterministic replay").
 *
 * docs/07 §6 asks a soak to prove the absence of six things over a long run: no
 * invalid numbers, no count corruption, no ID collision, no dead-entity leak,
 * snapshots that still round-trip, and a repeatable hash. Milestone 4 adds the
 * pressure that makes those failures reachable — every tick can now allocate and
 * release slots, so 100 000 ticks churn through tens of thousands of identities.
 *
 * ## Why a smaller world than DEFAULT_CONFIG
 *
 * The reference world's carrying capacity is far above the 8 192 organism safety
 * cap (see ADR 0006 §7), so a 100 000-tick run there spends most of its length
 * at ~8 000 organisms and costs upward of an hour — a test nobody would run.
 * This soak therefore uses a 96x96 world with 64 founders: the same biology, the
 * same phases, the same config in every ecological respect, at a population the
 * world can actually feed.
 *
 * That is not a weaker subject for what a soak measures. This world boom-crashes
 * repeatedly — the population swings between roughly 100 and 2 800 across the
 * run — which recycles slots far harder than a population pinned at a cap, and
 * it reaches deeper generations per tick of compute (~45 by tick 70 000 against
 * ~8 on the reference world at tick 10 000). The reference world's determinism is
 * pinned separately by the mandated 10 000-tick golden fixture and by
 * `evolutionSimulation.test.ts`.
 *
 * A 64x64 variant was measured first and rejected: it goes extinct around tick
 * 25 000, after which a soak silently stops testing anything.
 */

/**
 * The soak world: DEFAULT_CONFIG biology on a 1 536 LU map.
 *
 * Only geometry, founder count and the world-validity thresholds that scale with
 * area are changed. Every organism, brain, mutation, reproduction and plant
 * constant is DEFAULT_CONFIG's, because those are what the soak is checking.
 */
export const SOAK_GRID_SIZE = 96;
export const SOAK_FOUNDERS = 64;

const SOAK_CONFIG: ReadonlySimulationConfig = (() => {
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

const SOAK_SEED = 0xe0a12026;
const SOAK_TICKS = 100_000;

/**
 * State hash after 100 000 ticks of the soak world. Regenerate together with the
 * golden fixture whenever ENGINE_VERSION changes.
 *
 * Engine 0.5.0 moved it for the same two reasons the fixture moved: the carcass
 * store joined the hash stream, and carrion changes what organisms sense and
 * therefore do (ADR 0008 §5).
 */
const GOLDEN_SOAK_HASH = "84ee01707a012488";

interface Violations {
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
}

/** Full organism invariant sweep (docs/07 §4 development invariants). */
function checkOrganisms(engine: SimulationEngine, seenIds: Set<number>): Violations {
  const { organisms, config } = engine;
  // The phenotype cache is engine-internal (it is derived state, not part of the
  // public surface), and the energy bound needs the adult radius it holds.
  const { phenotypes } = engineInternals(engine).context;
  const maxPos = config.world.sizeLU * POS_SCALE - 1;
  const v: Violations = {
    identity: 0,
    leakedSlot: 0,
    energy: 0,
    health: 0,
    body: 0,
    bookkeeping: 0,
    lineage: 0,
    // Filled by countCarcassViolations at the call site: carcasses are a separate
    // store, and mixing their sweep into the organism loop would hide which of
    // the two actually broke.
    carcass: 0,
  };

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
    const mass = massFromRadiusPos(
      currentRadiusPos(
        phenotypes.adultRadiusPos[slot] as number,
        organisms.developmentQ[slot] as number,
      ),
      config.organism.massScalePerRadiusSquared,
    );
    // The upper bound is the one a birth could break: a child endowed with its
    // parent's investment must never be granted more than its own body holds.
    if (!Number.isSafeInteger(energy) || energy < 0 || energy > maxEnergyForMass(mass, config)) {
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

  return v;
}

const NO_VIOLATIONS: Violations = {
  identity: 0,
  leakedSlot: 0,
  energy: 0,
  health: 0,
  body: 0,
  bookkeeping: 0,
  lineage: 0,
  carcass: 0,
};

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

describe("100k tick evolutionary soak (task E07)", () => {
  // ~350 s of simulation on its own. The budget is deliberately several times
  // that: Vitest runs test files in parallel workers, and this file competes with
  // the 10 000-tick golden fixture and the two acceptance suites, so the observed
  // wall time under contention is 2-3x the isolated figure.
  it(
    "runs 100k ticks of live evolution without corruption and reproduces its hash",
    { timeout: 1_800_000 },
    () => {
      const engine = new SimulationEngine({ seed: SOAK_SEED, config: SOAK_CONFIG });
      const { environment, organisms } = engine;
      const capacity = totalPlantCapacity(environment);
      const seenIds = new Set<number>();

      let peakPopulation = organisms.liveCount;
      let peakGeneration = 0;
      let troughPopulation = organisms.liveCount;
      // Swept every 997 ticks: prime, so the samples never line up with the
      // 20-tick environment cadence or the 40-tick reproduction cooldown.
      const CHECK_EVERY = 997;

      for (let done = 0; done < SOAK_TICKS; done += CHECK_EVERY) {
        engine.stepMany(Math.min(CHECK_EVERY, SOAK_TICKS - done));

        const violations = checkOrganisms(engine, seenIds);
        violations.carcass = countCarcassViolations(engine);
        expect(`tick ${engine.tick}: ${JSON.stringify(violations)}`).toBe(
          `tick ${engine.tick}: ${JSON.stringify(NO_VIOLATIONS)}`,
        );

        peakPopulation = Math.max(peakPopulation, organisms.liveCount);
        troughPopulation = Math.min(troughPopulation, organisms.liveCount);
        for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
          if (organisms.alive[slot] === 1) {
            peakGeneration = Math.max(peakGeneration, organisms.generation[slot] as number);
          }
        }
      }

      expect(engine.tick).toBe(SOAK_TICKS);
      // Determinism is pinned against a recorded hash rather than by running a
      // second engine: it halves the time and is strictly stronger, because a
      // golden also catches drift across platforms and engine versions, which
      // two runs in the same process cannot.
      const soakHash = engine.computeStateHash();

      // --- Environment invariants (carried over from the Milestone 2 soak) ---
      let overCapacity = 0;
      let remainderOutOfRange = 0;
      let vegetatedWater = 0;
      let negativeBiomass = 0;
      for (let i = 0; i < environment.cellCount; i += 1) {
        const biomass = environment.plantBiomass[i] as number;
        if (biomass > (environment.plantCapacity[i] as number)) overCapacity += 1;
        if (biomass < 0) negativeBiomass += 1;
        if ((environment.plantGrowthRemainderQ[i] as number) >= Q) remainderOutOfRange += 1;
        if (environment.biome[i] === Biome.Water && biomass !== 0) vegetatedWater += 1;
      }
      expect({
        overCapacity,
        remainderOutOfRange,
        vegetatedWater,
        negativeBiomass,
      }).toEqual({
        overCapacity: 0,
        remainderOutOfRange: 0,
        vegetatedWater: 0,
        negativeBiomass: 0,
      });
      const finalBiomass = totalPlantBiomass(environment);
      expect(finalBiomass).toBeGreaterThanOrEqual(0);
      expect(finalBiomass).toBeLessThanOrEqual(capacity);

      // --- Evolution actually happened -----------------------------------
      // Deliberately loose: docs/07 §1 forbids asserting a specific
      // evolutionary story, so these only claim that the machinery ran.
      expect(organisms.totalBirths).toBeGreaterThan(SOAK_FOUNDERS * 20);
      expect(organisms.totalDeaths).toBeGreaterThan(SOAK_FOUNDERS * 10);
      expect(peakGeneration).toBeGreaterThan(20);
      expect(peakPopulation).toBeGreaterThan(SOAK_FOUNDERS * 4);
      // The lineage survives the whole run: a soak of an extinct world would
      // silently stop testing anything after the last death.
      expect(organisms.liveCount).toBeGreaterThan(0);
      // And it boom-crashes rather than sitting at one density. That is what makes
      // this world the right soak subject: slots are recycled in bulk, repeatedly,
      // which is the pressure the identity and free-list invariants above exist to
      // survive.
      expect(troughPopulation).toBeLessThan(peakPopulation / 4);

      // Deaths are fully attributed, and no cause counter overflowed.
      let byCause = 0;
      for (let cause = 0; cause < DEATH_CAUSE_COUNT; cause += 1) {
        byCause += organisms.deathsByCause[cause] as number;
      }
      expect(byCause).toBe(organisms.totalDeaths);

      // Entity IDs are monotonic and never reused: every birth consumed exactly
      // one, so the counter and the birth total agree forever.
      expect(organisms.nextEntityId).toBe(organisms.totalBirths + 1);

      // --- Mutation has not destroyed the brains (docs/07 §12) ------------
      // docs/07 §12 lists "mutation destroys brain too fast" as a calibration
      // failure to monitor, and this run is the deepest lineage the suite has:
      // sixty-odd generations of accumulated brain mutation. The observable is
      // whether a surviving controller still resembles the founder controller it
      // descends from, measured as cosine similarity against the founder weight
      // vector — 1.0 is the founder brain, 0.0 an unrelated one.
      //
      // Both bounds are deliberately loose, because docs/07 §1 forbids asserting
      // an evolutionary story: they separate "drifting under selection" from
      // "erased", nothing finer. An unrelated 400-dimensional brain would score
      // about 1/sqrt(400) = 0.05, so 0.2 is four times the noise floor. Measured
      // on this world during the Milestone 4 review: 0.976 at generation 8, 0.947
      // at 16 and 0.873 at 34, with the worst individual still at 0.824 and
      // 0.0008% of weights on the clamp (ADR 0007 §3).
      const founderBrain = createFounderBrainWeights(
        SOAK_CONFIG.brain.weightScale,
        SOAK_CONFIG.brain.weightMin,
        SOAK_CONFIG.brain.weightMax,
      );
      let founderNormSq = 0;
      for (let i = 0; i < BRAIN_WEIGHT_COUNT; i += 1) {
        founderNormSq += (founderBrain[i] as number) ** 2;
      }
      let similaritySum = 0;
      let brainsMeasured = 0;
      let weightsAtClamp = 0;
      for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
        if (organisms.alive[slot] !== 1) {
          continue;
        }
        const base = engine.genomes.weightOffset(slot);
        let dot = 0;
        let normSq = 0;
        for (let i = 0; i < BRAIN_WEIGHT_COUNT; i += 1) {
          const weight = engine.genomes.brainWeights[base + i] as number;
          dot += weight * (founderBrain[i] as number);
          normSq += weight * weight;
          if (weight === SOAK_CONFIG.brain.weightMin || weight === SOAK_CONFIG.brain.weightMax) {
            weightsAtClamp += 1;
          }
        }
        similaritySum += normSq > 0 ? dot / Math.sqrt(normSq * founderNormSq) : 0;
        brainsMeasured += 1;
      }
      expect(brainsMeasured).toBe(organisms.liveCount);
      expect(similaritySum / brainsMeasured).toBeGreaterThan(0.2);
      // The other half of the failure mode: weights piling onto the clamp would
      // mean the sigma is saturating brains rather than exploring with them.
      expect(weightsAtClamp / (brainsMeasured * BRAIN_WEIGHT_COUNT)).toBeLessThan(0.05);

      expect(soakHash).toBe(GOLDEN_SOAK_HASH);

      // --- Snapshots still round-trip after 100k ticks --------------------
      const restored = engineFromSnapshot(engine.serialize());
      expect(restored.computeStateHash()).toBe(soakHash);
      expect(restored.organisms.freeCount).toBe(organisms.freeCount);
      expect(restored.organisms.nextEntityId).toBe(organisms.nextEntityId);
      // Resuming a 100 000-tick save must continue identically, which is the
      // part a hash comparison at the snapshot tick alone cannot prove.
      restored.stepMany(500);
      engine.stepMany(500);
      expect(restored.computeStateHash()).toBe(engine.computeStateHash());
    },
  );
});
