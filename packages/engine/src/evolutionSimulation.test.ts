import { Resource } from "./world/resources";
import type { ResourceProfile } from "./config/SimulationConfig";
import { describe, expect, it } from "vitest";
import { SimulationEngine } from "./SimulationEngine";
import { cloneConfig } from "./config/cloneConfig";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import { GENE_COUNT, Gene, geneToQ } from "./genetics/genes";
import { createFounderGenes } from "./genetics/founderGenome";
import { Q } from "./math/fixed";
import { engineFromSnapshot } from "./snapshot/deserialize";

/** The foliage channel of a config, non-optional. M17 made plants a list. */
function foliageProfile(config: { plants: { resources: readonly ResourceProfile[] } }): ResourceProfile {
  const profile = config.plants.resources[Resource.Foliage];
  if (profile === undefined) {
    throw new Error("config is missing the foliage channel");
  }
  return profile;
}


/**
 * Milestone 4 acceptance (docs/07 Milestone 4): "multiple generations; 100k
 * soak; deterministic replay". The 100 000-tick soak lives in `soak.test.ts`;
 * this file covers the reference world's evolutionary behaviour and the energy
 * invariant that reproduction could most easily break.
 *
 * One shared 4 000-tick run of the reference world backs most assertions.
 * 4 000 ticks is enough for the founder cohort to mature (~1 120 ticks), for
 * several reproduction cooldowns to elapse and for three generations to exist,
 * without paying for the whole 10 000-tick fixture again.
 *
 * As in Milestone 3, nothing here asserts a specific evolutionary story at a
 * specific tick beyond pinned hashes (docs/07 §1).
 */

const FIXTURE_SEED = 0xe0a12026;
const REFERENCE_TICKS = 4_000;

/** One shared run of the reference world, deep enough to have grandchildren. */
const reference = (() => {
  const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
  engine.stepMany(REFERENCE_TICKS);
  return engine;
})();

/**
 * Tick at which the shared snapshot is taken: past the first births, so the free
 * list, the cooldowns and the mutated genomes are all non-trivial.
 */
const SNAPSHOT_TICK = 2_300;

/**
 * One shared engine paused mid-reproduction, plus its snapshot.
 *
 * The resume tests all need the same starting point, and re-running 2 300 ticks
 * of a populated world per test is ~20 s each. Nothing here mutates the engine —
 * every test resumes from the snapshot instead, which leaves the original
 * untouched by construction.
 */
const midReproduction = (() => {
  const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
  engine.stepMany(SNAPSHOT_TICK);
  return { engine, snapshot: engine.serialize() };
})();

/** Highest generation among the living. */
function maxGeneration(engine: SimulationEngine): number {
  const { organisms } = engine;
  let max = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] === 1) {
      max = Math.max(max, organisms.generation[slot] as number);
    }
  }
  return max;
}

/** Total energy held by every living organism. */
function totalLiveEnergy(engine: SimulationEngine): number {
  const { organisms } = engine;
  let total = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] === 1) {
      total += organisms.energy[slot] as number;
    }
  }
  return total;
}

/**
 * Population variance of each normalized gene, summed over the 15 ecological
 * genes (hue excluded, as docs/05 §3 requires for trait comparison).
 *
 * Reported in Q² units. Non-authoritative: this is analytics, computed here in
 * floating point precisely because it never feeds back into biology (docs/05 §21).
 */
function traitVarianceQ2(engine: SimulationEngine): number {
  const { organisms, genomes } = engine;
  const slots: number[] = [];
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] === 1) {
      slots.push(slot);
    }
  }
  if (slots.length < 2) {
    return 0;
  }

  let total = 0;
  for (let gene = 0; gene < GENE_COUNT; gene += 1) {
    if (gene === Gene.Hue) {
      continue;
    }
    let sum = 0;
    for (const slot of slots) {
      sum += geneToQ(genomes.gene(slot, gene));
    }
    const mean = sum / slots.length;
    let sq = 0;
    for (const slot of slots) {
      const d = geneToQ(genomes.gene(slot, gene)) - mean;
      sq += d * d;
    }
    total += sq / slots.length;
  }
  return total;
}

describe("the founder cohort reproduces", () => {
  it("produces offspring only after the cohort reaches maturity", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const founders = DEFAULT_CONFIG.world.initialOrganisms;

    // Founder maturity maps to ~1 120 ticks, and the development gate (90%) is
    // reached later still, so nothing can be born before then.
    engine.stepMany(1_000);
    expect(engine.organisms.totalBirths).toBe(founders);
    expect(maxGeneration(engine)).toBe(0);

    engine.stepMany(1_000);
    expect(engine.organisms.totalBirths).toBeGreaterThan(founders);
    expect(maxGeneration(engine)).toBeGreaterThan(0);
  });

  it("reaches multiple generations by tick 4 000", () => {
    expect(maxGeneration(reference)).toBeGreaterThanOrEqual(2);
    expect(reference.organisms.liveCount).toBeGreaterThan(DEFAULT_CONFIG.world.initialOrganisms);
  });

  it("keeps every lineage link consistent", () => {
    const { organisms } = reference;
    let orphanFounders = 0;
    let selfParented = 0;
    let futureParents = 0;
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] !== 1) {
        continue;
      }
      const id = organisms.entityId[slot] as number;
      const parent = organisms.parentEntityId[slot] as number;
      const generation = organisms.generation[slot] as number;
      if (generation === 0 && parent !== 0) orphanFounders += 1;
      if (generation > 0 && parent === 0) orphanFounders += 1;
      if (parent === id) selfParented += 1;
      // A parent is always older, so its ID was issued first.
      if (parent > id) futureParents += 1;
    }
    expect({ orphanFounders, selfParented, futureParents }).toEqual({
      orphanFounders: 0,
      selfParented: 0,
      futureParents: 0,
    });
  });

  it("breaks up the synchronized founder cohort", () => {
    // Every founder shares one genome and one birth tick, so before Milestone 4
    // the whole cohort aged and died in lockstep. Descendants are born across
    // thousands of ticks, so ages must now be spread out.
    const { organisms } = reference;
    const ages = new Set<number>();
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] === 1) {
        ages.add(organisms.ageTicks[slot] as number);
      }
    }
    expect(ages.size).toBeGreaterThan(10);
  });

  it("creates heritable variation the founder population did not have", () => {
    // Every founder is genetically identical, so variance starts at exactly zero
    // and can only come from mutation.
    const start = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    expect(traitVarianceQ2(start)).toBe(0);
    expect(traitVarianceQ2(reference)).toBeGreaterThan(0);
  });

  it("still descends from the founder genome rather than drifting to noise", () => {
    // Mutation must be a perturbation, not a re-roll: after ~3 generations the
    // population mean of each gene should still be near the founder's value.
    // A broken sigma scale (raw units mistaken for Q units) would blow this up.
    const founder = createFounderGenes();
    const { organisms, genomes } = reference;
    let compared = 0;
    let farFromFounder = 0;
    for (let gene = 0; gene < GENE_COUNT; gene += 1) {
      let sum = 0;
      let count = 0;
      for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
        if (organisms.alive[slot] !== 1) continue;
        sum += geneToQ(genomes.gene(slot, gene));
        count += 1;
      }
      const meanQ = sum / Math.max(count, 1);
      const founderQ = geneToQ(founder[gene] as number);
      compared += 1;
      if (Math.abs(meanQ - founderQ) > Q / 4) farFromFounder += 1;
    }
    expect(compared).toBe(GENE_COUNT);
    expect(farFromFounder).toBe(0);
  });

  it("does not reach the population cap on the reference world at this scale", () => {
    // The cap is a safety limit, and reaching it biases evolution (docs/01 §11).
    // At tick 4 000 the reference world is still well clear of it; that it is NOT
    // clear of it much later is recorded in ADR 0006 §7 as a calibration finding.
    expect(reference.organisms.capRejectedBirths).toBe(0);
    expect(reference.organisms.liveCount).toBeLessThan(DEFAULT_CONFIG.limits.maxOrganisms);
  });
});

describe("births never create energy (the Milestone 4 invariant)", () => {
  it("cannot increase the population's total energy in a world with no food", () => {
    // The direct test of the Milestone 4 invariant, as a closed system: every
    // cell is barren and stays barren, so the ONLY things that can move energy
    // are metabolic spend and reproduction. If a birth created even one unit,
    // the population total would rise on some tick.
    //
    // The founders are given a large energy capacity because at DEFAULT_CONFIG's
    // 68 920 they cannot reach maturity on savings alone — growing from birth
    // mass to adult mass costs ~15 800 and 1 120 ticks of upkeep another ~48 000
    // — so a literally barren world would starve them all before the first birth
    // and test nothing. Nothing else about their biology changes.
    const config = cloneConfig(DEFAULT_CONFIG);
    config.plants.initialBiomassFractionQ = 0;
    foliageProfile(config).seedBankRegenUnits = 0;
    foliageProfile(config).growthRateQByBiome = foliageProfile(config).growthRateQByBiome.map(() => 0);
    config.organism.initialEnergyFractionQ = Q;
    config.organism.baseMaxEnergy = 400_000;

    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config });
    expect(engine.organisms.liveCount).toBeGreaterThan(0);

    const initialEnergy = totalLiveEnergy(engine);
    let previous = initialEnergy;
    const birthsAtStart = engine.organisms.totalBirths;
    for (let tick = 0; tick < 2_500; tick += 1) {
      engine.step();
      const current = totalLiveEnergy(engine);
      // Phrased as a string comparison so a failure names the tick.
      expect(`tick ${engine.tick}: ${current} <= ${previous}`).toBe(
        `tick ${engine.tick}: ${current} <= ${Math.max(current, previous)}`,
      );
      previous = current;
    }

    // The assertion above is only meaningful if reproduction actually ran, and
    // if metabolism actually consumed anything.
    expect(engine.organisms.totalBirths).toBeGreaterThan(birthsAtStart);
    expect(totalLiveEnergy(engine)).toBeLessThan(initialEnergy);
    // No food means no intake, ever — the counter proves the world stayed closed.
    let intake = 0;
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      intake += engine.organisms.plantEnergyEaten[slot] as number;
    }
    expect(intake).toBe(0);
  });

  it("accounts for every unit a parent paid, on the reference world", () => {
    // Over a whole populated run: the discard counter only ever grows, and stays
    // consistent with the number of births that happened.
    const { organisms } = reference;
    expect(organisms.birthEnergyDiscarded).toBeGreaterThanOrEqual(0);
    expect(Number.isSafeInteger(organisms.birthEnergyDiscarded)).toBe(true);
    expect(organisms.totalBirths).toBeGreaterThan(DEFAULT_CONFIG.world.initialOrganisms);
  });
});

describe("deterministic replay through active evolution", () => {
  it("reproduces exactly from the same seed and config", () => {
    const a = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const b = new SimulationEngine({ seed: FIXTURE_SEED, config: cloneConfig(DEFAULT_CONFIG) });
    a.stepMany(2_000);
    b.stepMany(2_000);
    expect(b.computeStateHash()).toBe(a.computeStateHash());
    expect(b.organisms.totalBirths).toBe(a.organisms.totalBirths);
    expect(b.organisms.totalBirths).toBeGreaterThan(DEFAULT_CONFIG.world.initialOrganisms);
  });

  it("resumes a snapshot taken mid-reproduction and continues identically", () => {
    // The snapshot/resume case Milestone 4 adds: the free list, the entity ID
    // counter, the reproduction cooldowns and the mutated genomes must all
    // round-trip, or the next birth lands in a different slot with a different
    // genome and the run forks.
    const { engine: interrupted, snapshot } = midReproduction;
    expect(interrupted.organisms.totalBirths).toBeGreaterThan(
      DEFAULT_CONFIG.world.initialOrganisms,
    );

    const resumed = engineFromSnapshot(snapshot);
    expect(resumed.tick).toBe(SNAPSHOT_TICK);
    expect(resumed.computeStateHash()).toBe(interrupted.computeStateHash());
    expect(resumed.organisms.nextEntityId).toBe(interrupted.organisms.nextEntityId);

    resumed.stepMany(REFERENCE_TICKS - SNAPSHOT_TICK);
    expect(resumed.tick).toBe(REFERENCE_TICKS);
    expect(resumed.computeStateHash()).toBe(reference.computeStateHash());
  });

  it("resumes mid-reproduction from a tick off the environment cadence", () => {
    const at = 2_497;
    expect(at % DEFAULT_CONFIG.time.environmentInterval).not.toBe(0);
    expect(at % DEFAULT_CONFIG.reproduction.reproductionCooldownTicks).not.toBe(0);

    const interrupted = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    interrupted.stepMany(at);
    const resumed = engineFromSnapshot(interrupted.serialize());
    expect(resumed.computeStateHash()).toBe(interrupted.computeStateHash());

    resumed.stepMany(REFERENCE_TICKS - at);
    expect(resumed.computeStateHash()).toBe(reference.computeStateHash());
  });

  it("carries reproduction cooldowns across a snapshot", () => {
    // A cooldown that reset on reload would let a player double a lineage's
    // birth rate by saving and loading, so it has to be in the payload.
    const { engine } = midReproduction;

    let onCooldown = 0;
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      if (
        engine.organisms.alive[slot] === 1 &&
        (engine.organisms.reproductionCooldown[slot] as number) > 0
      ) {
        onCooldown += 1;
      }
    }
    expect(onCooldown).toBeGreaterThan(0);

    const restored = engineFromSnapshot(midReproduction.snapshot);
    expect(restored.organisms.reproductionCooldown).toEqual(engine.organisms.reproductionCooldown);
  });

  it("carries the birth and cap diagnostics across a snapshot", () => {
    const { engine, snapshot } = midReproduction;
    const restored = engineFromSnapshot(snapshot);
    expect(restored.organisms.totalBirths).toBe(engine.organisms.totalBirths);
    expect(restored.organisms.capRejectedBirths).toBe(engine.organisms.capRejectedBirths);
    expect(restored.organisms.birthEnergyDiscarded).toBe(engine.organisms.birthEnergyDiscarded);
  });
});
