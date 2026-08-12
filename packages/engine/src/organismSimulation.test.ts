import { describe, expect, it } from "vitest";
import { POS_SCALE, Q } from "./math/fixed";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import { cloneConfig } from "./config/cloneConfig";
import { DEATH_CAUSE_COUNT, DeathCause } from "./organisms/death";
import { engineFromSnapshot } from "./snapshot/deserialize";
import { SimulationEngine } from "./SimulationEngine";
import { totalPlantBiomass } from "./world/plants";

/**
 * Milestone 3 acceptance (docs/07 Milestone 3): "founder forages/survives
 * calibrated world; no heuristic after spawn; deterministic 10k".
 *
 * One 10 000-tick run of the reference world backs most of these assertions,
 * so the suite states an ecological story rather than re-running the engine
 * per claim. What it deliberately does NOT do is assert a specific outcome at
 * a specific tick beyond the pinned hash — docs/07 §1 forbids brittle
 * evolutionary stories, and Milestone 3 has no reproduction, so the founder
 * cohort can only shrink.
 */

const FIXTURE_SEED = 0xe0a12026;

interface Sample {
  tick: number;
  population: number;
  meanEnergyRatioQ: number;
  meanDevelopmentQ: number;
  meanHealthQ: number;
  totalPlantEnergyEaten: number;
}

function sample(engine: SimulationEngine): Sample {
  const { organisms } = engine;
  let energy = 0;
  let development = 0;
  let health = 0;
  let eaten = 0;
  let alive = 0;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    alive += 1;
    energy += organisms.energy[slot] as number;
    development += organisms.developmentQ[slot] as number;
    health += organisms.healthQ[slot] as number;
    eaten += organisms.plantEnergyEaten[slot] as number;
  }
  const n = Math.max(alive, 1);
  return {
    tick: engine.tick,
    population: alive,
    meanEnergyRatioQ: Math.trunc(energy / n),
    meanDevelopmentQ: Math.trunc(development / n),
    meanHealthQ: Math.trunc(health / n),
    totalPlantEnergyEaten: eaten,
  };
}

/** One shared 10 000-tick run of the reference world. */
const reference = (() => {
  const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
  const samples: Sample[] = [sample(engine)];
  const checkpoints = [100, 500, 1_000, 2_000, 3_000, 5_000, 6_000, 10_000];
  const biomassAtStart = totalPlantBiomass(engine.environment);
  for (const target of checkpoints) {
    engine.stepMany(target - engine.tick);
    samples.push(sample(engine));
  }
  return {
    engine,
    samples,
    biomassAtStart,
    at(tick: number): Sample {
      const found = samples.find((entry) => entry.tick === tick);
      if (found === undefined) {
        throw new Error(`no sample at tick ${tick}`);
      }
      return found;
    },
  };
})();

describe("founder population spawns into the world", () => {
  // World generation plus 256 spawns costs ~100 ms, and none of these
  // assertions mutate anything, so one instance serves them all.
  const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });

  it("places the configured number of founders before the first tick", () => {
    expect(engine.organisms.liveCount).toBe(DEFAULT_CONFIG.world.initialOrganisms);
    expect(engine.organisms.totalBirths).toBe(DEFAULT_CONFIG.world.initialOrganisms);
    expect(engine.organisms.slotHighWater).toBe(DEFAULT_CONFIG.world.initialOrganisms);
  });

  it("gives every founder a distinct non-zero entity ID", () => {
    const ids = new Set<number>();
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      const id = engine.organisms.entityId[slot] as number;
      expect(id).not.toBe(0);
      ids.add(id);
    }
    expect(ids.size).toBe(DEFAULT_CONFIG.world.initialOrganisms);
  });

  it("places them on land, inside the world, near the founder region", () => {
    const { environment, founderRegion, organisms } = engine;
    const maxPos = DEFAULT_CONFIG.world.sizeLU * POS_SCALE - 1;
    const cellSizePos = environment.cellSizeLU * POS_SCALE;
    const centerX = founderRegion.centerGridX * cellSizePos + (cellSizePos >> 1);
    const centerY = founderRegion.centerGridY * cellSizePos + (cellSizePos >> 1);
    const radius = DEFAULT_CONFIG.world.founderSpawnRadiusLU * POS_SCALE;

    let offLand = 0;
    let outOfBounds = 0;
    let outsideRegion = 0;
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      const x = organisms.x[slot] as number;
      const y = organisms.y[slot] as number;
      if (x < 0 || y < 0 || x > maxPos || y > maxPos) {
        outOfBounds += 1;
      }
      if (environment.isWaterCell(environment.cellIndexFromPosition(x, y))) {
        offLand += 1;
      }
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy > radius * radius) {
        outsideRegion += 1;
      }
    }
    expect({ offLand, outOfBounds, outsideRegion }).toEqual({
      offLand: 0,
      outOfBounds: 0,
      outsideRegion: 0,
    });
  });

  it("starts them as newborns with the configured energy fraction", () => {
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      expect(engine.organisms.ageTicks[slot]).toBe(0);
      expect(engine.organisms.developmentQ[slot]).toBe(DEFAULT_CONFIG.organism.birthSizeFractionQ);
      expect(engine.organisms.healthQ[slot]).toBe(Q);
      expect(engine.organisms.generation[slot]).toBe(0);
      expect(engine.organisms.parentEntityId[slot]).toBe(0);
      expect(engine.organisms.speciesId[slot]).toBe(1);
      expect(engine.organisms.energy[slot]).toBeGreaterThan(0);
    }
  });

  it("spawns from the world PRNG, so headings and positions differ", () => {
    const angles = new Set<number>();
    const positions = new Set<string>();
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      angles.add(engine.organisms.angle[slot] as number);
      positions.add(`${engine.organisms.x[slot]},${engine.organisms.y[slot]}`);
    }
    expect(angles.size).toBeGreaterThan(200);
    expect(positions.size).toBe(DEFAULT_CONFIG.world.initialOrganisms);
  });

  it("puts a different founder population in a different world", () => {
    const other = new SimulationEngine({ seed: 12345, config: DEFAULT_CONFIG });
    expect(engine.organisms.x[0]).not.toBe(other.organisms.x[0]);
  });
});

describe("founder forages and survives the calibrated world", () => {
  it("actually feeds, rather than starving next to food", () => {
    // The founder controller is calibrated, not scripted: it feeds because its
    // eat output clears the threshold on vegetated ground, and for no other
    // reason. A founder that never attempted to feed would show zero intake.
    expect(reference.at(100).totalPlantEnergyEaten).toBeGreaterThan(0);
    expect(reference.at(1_000).totalPlantEnergyEaten).toBeGreaterThan(
      reference.at(100).totalPlantEnergyEaten,
    );
  });

  it("grows to maturity on what it forages", () => {
    const birth = DEFAULT_CONFIG.organism.birthSizeFractionQ;
    expect(reference.at(0).meanDevelopmentQ).toBe(birth);
    expect(reference.at(500).meanDevelopmentQ).toBeGreaterThan(birth);
    // Founder maturity is ~1120 ticks, so the cohort is fully grown by 2 000.
    expect(reference.at(2_000).meanDevelopmentQ).toBe(Q);
  });

  it("keeps most of the cohort alive well past maturity", () => {
    const founders = DEFAULT_CONFIG.world.initialOrganisms;
    expect(reference.at(1_000).population).toBe(founders);
    expect(reference.at(3_000).population).toBeGreaterThan(founders / 2);
    expect(reference.at(5_000).population).toBeGreaterThan(founders / 2);
  });

  it("is viable but mediocre: some founders lose the competition for food", () => {
    // docs/07 §15. A world where nothing ever starves would have no selection
    // pressure at all, which is worse than one that is slightly too harsh.
    expect(reference.engine.organisms.deathsByCause[DeathCause.Starvation]).toBeGreaterThan(0);
    expect(reference.at(5_000).meanHealthQ).toBeLessThan(Q);
    expect(reference.at(5_000).meanHealthQ).toBeGreaterThan(Q / 2);
  });

  it("dies of old age at the genetic maximum, since nothing reproduces yet", () => {
    // Every founder shares one genome, so the whole cohort reaches its 6 100
    // tick maximum together. Reproduction (Milestone 4) is what breaks up this
    // synchronized cohort.
    expect(reference.at(6_000).population).toBeGreaterThan(0);
    expect(reference.at(10_000).population).toBe(0);
    expect(reference.engine.organisms.deathsByCause[DeathCause.OldAge]).toBeGreaterThan(0);
  });

  it("grazes the world without collapsing it", () => {
    const finalBiomass = totalPlantBiomass(reference.engine.environment);
    expect(finalBiomass).toBeGreaterThan(0);
    // 256 organisms cannot dent a 65 536-cell world's total, but they do
    // consume: the intake counter is the direct evidence.
    expect(reference.at(6_000).totalPlantEnergyEaten).toBeGreaterThan(0);
  });

  it("never leaves an organism in an impossible state", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const maxPos = DEFAULT_CONFIG.world.sizeLU * POS_SCALE - 1;
    const seenIds = new Set<number>();

    for (let tick = 0; tick < 1_200; tick += 1) {
      engine.step();
      if (tick % 137 !== 0) {
        continue;
      }
      seenIds.clear();
      const { organisms } = engine;
      let violations = 0;
      for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
        if (organisms.alive[slot] !== 1) {
          // A free slot must be fully cleared (docs/07 §4).
          if ((organisms.entityId[slot] as number) !== 0) {
            violations += 1;
          }
          continue;
        }
        const id = organisms.entityId[slot] as number;
        if (id === 0 || seenIds.has(id)) {
          violations += 1;
        }
        seenIds.add(id);
        if ((organisms.energy[slot] as number) < 0) violations += 1;
        if ((organisms.healthQ[slot] as number) === 0) violations += 1;
        if ((organisms.healthQ[slot] as number) > Q) violations += 1;
        const x = organisms.x[slot] as number;
        const y = organisms.y[slot] as number;
        if (x < 0 || y < 0 || x > maxPos || y > maxPos) violations += 1;
        if ((organisms.developmentQ[slot] as number) > Q) violations += 1;
      }
      expect(`tick ${tick}: ${violations} violations`).toBe(`tick ${tick}: 0 violations`);
    }
  });

  it("accounts for every organism that ever lived", () => {
    const { organisms } = reference.engine;
    let byCause = 0;
    for (let cause = 0; cause < DEATH_CAUSE_COUNT; cause += 1) {
      byCause += organisms.deathsByCause[cause] as number;
    }
    expect(byCause).toBe(organisms.totalDeaths);
    expect(organisms.totalBirths - organisms.totalDeaths).toBe(organisms.liveCount);
  });
});

describe("no post-spawn heuristics", () => {
  it("leaves the authoritative PRNG untouched by the tick loop", () => {
    // Founder spawn is the only PRNG consumer in Milestone 3. If any phase
    // secretly drew from it — a random nudge, a tie broken by chance — the
    // generator state would move.
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const afterSpawn = engine.getRngState();
    engine.stepMany(300);
    expect(engine.getRngState()).toEqual(afterSpawn);
  });

  it("reduces a silenced brain to pure neutral output, with no behaviour left over", () => {
    // All weights zero means every raw activation is zero, which the output
    // mapping turns into a neutral half for the positive actions and an exact
    // zero for turn (docs/04 §11). So the organism coasts straight ahead and
    // does nothing else: it never turns, never feeds, never attacks. Anything
    // it still did would be a hard-coded heuristic rather than an evolved one.
    const config = cloneConfig(DEFAULT_CONFIG);
    config.world.initialOrganisms = 32;
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config });
    engine.genomes.brainWeights.fill(0);

    const headings: number[] = [];
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      headings.push(engine.organisms.angle[slot] as number);
    }

    engine.stepMany(50);
    let turned = 0;
    let fed = 0;
    let attacked = 0;
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      if (engine.organisms.alive[slot] !== 1) {
        continue;
      }
      if (engine.organisms.angle[slot] !== headings[slot]) turned += 1;
      if ((engine.organisms.plantEnergyEaten[slot] as number) !== 0) fed += 1;
      if ((engine.organisms.kills[slot] as number) !== 0) attacked += 1;
    }
    expect({ turned, fed, attacked }).toEqual({ turned: 0, fed: 0, attacked: 0 });
  });
});

describe("deterministic 10k founder simulation", () => {
  it("reproduces exactly from the same seed and config", () => {
    const a = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const b = new SimulationEngine({ seed: FIXTURE_SEED, config: cloneConfig(DEFAULT_CONFIG) });
    a.stepMany(400);
    b.stepMany(400);
    expect(b.computeStateHash()).toBe(a.computeStateHash());
    expect(b.organisms.liveCount).toBe(a.organisms.liveCount);
  });

  it("diverges for a different seed", () => {
    const a = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const b = new SimulationEngine({ seed: FIXTURE_SEED + 1, config: DEFAULT_CONFIG });
    a.stepMany(200);
    b.stepMany(200);
    expect(b.computeStateHash()).not.toBe(a.computeStateHash());
  });

  it("matches a snapshot taken mid-run and resumed to tick 10 000", () => {
    // The required snapshot/resume acceptance at full scale: an interrupted
    // run must be bit-identical to an uninterrupted one, which means the free
    // list, the entity ID counter and every organism array round-tripped
    // exactly.
    const interrupted = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    interrupted.stepMany(3_000);
    const snapshot = interrupted.serialize();

    const resumed = engineFromSnapshot(snapshot);
    expect(resumed.tick).toBe(3_000);
    expect(resumed.computeStateHash()).toBe(interrupted.computeStateHash());
    expect(resumed.organisms.liveCount).toBe(interrupted.organisms.liveCount);
    expect(resumed.organisms.nextEntityId).toBe(interrupted.organisms.nextEntityId);

    resumed.stepMany(7_000);
    expect(resumed.tick).toBe(10_000);
    expect(resumed.computeStateHash()).toBe(reference.engine.computeStateHash());
  });

  it("round-trips a snapshot with dead slots on the free list", () => {
    // Taken after the cohort has started dying, so the snapshot carries a
    // non-empty free list. Rebuilding that list by scanning for dead slots
    // instead of restoring it verbatim would change which slot the next birth
    // lands in (docs/10 §18).
    const engine = reference.engine;
    expect(engine.organisms.freeCount).toBeGreaterThan(0);

    const restored = engineFromSnapshot(engine.serialize());
    expect(restored.organisms.freeCount).toBe(engine.organisms.freeCount);
    expect(restored.organisms.liveCount).toBe(engine.organisms.liveCount);
    expect(restored.computeStateHash()).toBe(engine.computeStateHash());
    // The next slot handed out is the same one on both sides.
    expect(restored.organisms.allocateSlot()).toBe(engine.organisms.allocateSlot());
  });

  it("recomputes the phenotype cache on restore instead of storing it", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    engine.stepMany(200);
    const snapshot = engine.serialize();
    expect(snapshot).not.toHaveProperty("phenotypes");

    const restored = engineFromSnapshot(snapshot);
    // A recomputed cache must be able to continue the run bit-identically.
    restored.stepMany(200);
    engine.stepMany(200);
    expect(restored.computeStateHash()).toBe(engine.computeStateHash());
  });
});
