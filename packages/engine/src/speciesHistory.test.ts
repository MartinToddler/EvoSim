import { describe, expect, it } from "vitest";
import { BRAIN_WEIGHT_COUNT } from "./brain/BrainLayout";
import { cloneConfig, type ReadonlySimulationConfig } from "./config/cloneConfig";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import { SpeciesEndReason } from "./evolution/SpeciesStore";
import { GENE_COUNT, Gene, geneFromQ } from "./genetics/genes";
import { createFounderMorphGenes } from "./morphology/founderMorphGenome";
import { createFounderGenes } from "./genetics/founderGenome";
import { WorldEventType } from "./history/EventStore";
import { engineInternals } from "./internal";
import { POS_SCALE, Q } from "./math/fixed";
import { DeathCause } from "./organisms/death";
import { spawnOrganism } from "./organisms/spawn";
import { SimulationEngine } from "./SimulationEngine";

/**
 * Species + history through the REAL engine: snapshot round-trips, pending
 * split restoration, extinction, stable identity and the acyclic tree
 * (docs/05 §§5–8, docs/07 §3, fixtures 7, 8, 10, 12 and the short end of 13).
 *
 * The world is engineered to make speciation the only thing happening: no
 * founders, no mutation, silent brains (no movement, no eating, no combat, no
 * reproduction) and near-zero metabolism, so planted phenotype clouds persist
 * unchanged while the analysis cadence runs. Nothing in the scenario draws
 * from the PRNG after construction, but the full tick pipeline runs — the
 * point is that phases 16 and 17 behave identically live and after restore.
 */

const GRID_SIZE = 64;
const SEED = 0xe0a1_2026;

const CONFIG: ReadonlySimulationConfig = (() => {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.envGridSize = GRID_SIZE;
  config.world.sizeLU = GRID_SIZE * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(GRID_SIZE / 8));
  config.world.initialOrganisms = 0;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.world.validity.minFounderRegionCells = Math.floor((GRID_SIZE * GRID_SIZE) / 8);
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity / 16,
  );
  // Fast analysis cadence so five stability intervals fit a short test.
  config.time.speciesAnalysisInterval = 50;
  config.time.statisticsInterval = 50;
  // Freeze evolution and metabolism: the clouds must not drift or die.
  config.mutation.ecological.perGeneMutationProbabilityQ = 0;
  config.mutation.ecological.largeMutationProbabilityQ = 0;
  config.mutation.ecological.resetProbabilityQ = 0;
  config.mutation.brain.perWeightMutationProbabilityQ = 0;
  config.mutation.brain.largeWeightMutationProbabilityQ = 0;
  config.organism.basal.baseMassPaceCoeffQ = 0;
  config.organism.basal.muscleCapacityCoeffQ = 0;
  config.organism.basal.visionBaseCost = 0;
  config.organism.basal.attackMaintCoeffQ = 0;
  config.organism.basal.armorMaintCoeffQ = 0;
  config.organism.basal.toleranceMaintCoeffQ = 0;
  config.organism.basal.longevityMaintCoeffQ = 0;
  return config;
})();

/** Two well-separated ecological profiles (same shape as the unit fixtures). */
const PROFILE_A: Partial<Record<number, number>> = {
  [Gene.AdultSize]: Math.trunc(Q * 0.15),
  [Gene.MaxSpeed]: Math.trunc(Q * 0.2),
  [Gene.Diet]: Math.trunc(Q * 0.1),
  [Gene.VisionRange]: Math.trunc(Q * 0.2),
  [Gene.AttackPower]: Math.trunc(Q * 0.1),
  [Gene.MaxAge]: Q,
  [Gene.ThermalTolerance]: Q,
};
const PROFILE_B: Partial<Record<number, number>> = {
  [Gene.AdultSize]: Math.trunc(Q * 0.85),
  [Gene.MaxSpeed]: Math.trunc(Q * 0.8),
  [Gene.Diet]: Math.trunc(Q * 0.9),
  [Gene.VisionRange]: Math.trunc(Q * 0.8),
  [Gene.AttackPower]: Math.trunc(Q * 0.9),
  [Gene.MaxAge]: Q,
  [Gene.ThermalTolerance]: Q,
};

/** Plant one cloud of silent-brained organisms on land cells. */
function plantCloud(
  engine: SimulationEngine,
  profile: Partial<Record<number, number>>,
  count: number,
): void {
  const { context } = engineInternals(engine);
  const { environment, config } = context;
  const genes = createFounderGenes();
  for (const [gene, valueQ] of Object.entries(profile)) {
    genes[Number(gene) % GENE_COUNT] = geneFromQ(valueQ as number);
  }
  const silentBrain = new Int16Array(BRAIN_WEIGHT_COUNT);
  const cellSizePos = environment.cellSizeLU * POS_SCALE;

  let planted = 0;
  for (let cell = 0; cell < environment.cellCount && planted < count; cell += 1) {
    if (environment.isWaterCell(cell)) {
      continue;
    }
    const gridX = cell % config.world.envGridSize;
    const gridY = Math.trunc(cell / config.world.envGridSize);
    // Keep away from the map edge so soft collisions cannot push into water.
    if (gridX < 4 || gridY < 4 || gridX >= GRID_SIZE - 4 || gridY >= GRID_SIZE - 4) {
      continue;
    }
    const slot = spawnOrganism(context, {
      xPos: gridX * cellSizePos + (cellSizePos >> 1),
      yPos: gridY * cellSizePos + (cellSizePos >> 1),
      angle: 0,
      genes,
      morphGenes: createFounderMorphGenes(config.organism.morphology),
      brainWeights: silentBrain,
      generation: 0,
      parentEntityId: 0,
      speciesId: 1,
      energy: { kind: "fractionOfMax", fractionQ: Q },
    });
    expect(slot).toBeGreaterThanOrEqual(0);
    planted += 1;
  }
  expect(planted).toBe(count);
}

/** A fresh two-cloud world on the deterministic fixture seed. */
function createTwoCloudEngine(): SimulationEngine {
  const engine = new SimulationEngine({ seed: SEED, config: CONFIG });
  plantCloud(engine, PROFILE_A, 25);
  plantCloud(engine, PROFILE_B, 25);
  return engine;
}

/** Kill every live member of one species before the next step finalizes it. */
function scheduleSpeciesDeath(engine: SimulationEngine, speciesId: number): void {
  const { context } = engineInternals(engine);
  const { organisms, scratch } = context;
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] === 1 && organisms.speciesId[slot] === speciesId) {
      scratch.pendingDeath[slot] = 1;
      scratch.deathCause[slot] = DeathCause.Meteor;
    }
  }
}

describe("speciation through the live engine", () => {
  it("splits at the fifth analysis and the registry survives the split intact", () => {
    const engine = createTwoCloudEngine();
    // Analyses run inside the steps that begin at ticks 0, 50, 100, 150, 200.
    engine.stepMany(201);

    const species = engine.species;
    expect(species.count).toBe(3);
    expect(species.get(1).endReason).toBe(SpeciesEndReason.Split);
    expect(species.get(1).endTick).toBe(200);
    expect(species.get(2).population + species.get(3).population).toBe(50);
    expect(species.activeCount).toBe(2);

    const splitEvents = engine.events.events.filter(
      (event) => event.type === WorldEventType.SpeciesSplit,
    );
    expect(splitEvents).toHaveLength(1);
    expect(splitEvents[0]?.tick).toBe(200);
  });

  it("fixture 10: a pending split survives snapshot/restore and lands on the identical tick", () => {
    const control = createTwoCloudEngine();
    const saved = createTwoCloudEngine();

    // Both worlds reach tick 120: three qualifying analyses are recorded.
    control.stepMany(120);
    saved.stepMany(120);
    expect(saved.species.get(1).candidate?.passes).toBe(3);

    const restored = SimulationEngine.fromSnapshot(saved.serialize());
    expect(restored.computeStateHash()).toBe(saved.computeStateHash());
    expect(restored.species.get(1).candidate?.passes).toBe(3);

    // Continue both to well past the split.
    control.stepMany(280);
    restored.stepMany(280);

    expect(restored.tick).toBe(control.tick);
    expect(restored.computeStateHash()).toBe(control.computeStateHash());
    expect(restored.species.count).toBe(3);
    expect(restored.species.get(1).endTick).toBe(200);
    expect(control.species.get(1).endTick).toBe(200);

    // The event logs agree entry for entry — same IDs, same ticks.
    expect(restored.events.events).toEqual(control.events.events);
    // The statistics series are serialized-but-not-hashed state; they must
    // still be byte-identical after restore + continuation (docs/02 §9).
    expect(restored.stats.capture()).toEqual(control.stats.capture());
  });

  it("fixture 7+8: extinction is recorded permanently and identity survives save/load", () => {
    const engine = createTwoCloudEngine();
    engine.stepMany(201); // split happened at tick 200

    scheduleSpeciesDeath(engine, 2);
    engine.step(); // finalizes at tick 201

    const extinct = engine.species.get(2);
    expect(extinct.endReason).toBe(SpeciesEndReason.Extinct);
    expect(extinct.endTick).toBe(201);
    expect(extinct.population).toBe(0);
    expect(engine.species.activeCount).toBe(1);
    const extinctionEvents = engine.events.events.filter(
      (event) => event.type === WorldEventType.SpeciesExtinct,
    );
    expect(extinctionEvents).toHaveLength(1);
    expect(extinctionEvents[0]?.speciesIds).toEqual([2]);

    // Save/load: every record keeps its ID, status and lineage; the counter
    // continues rather than restarting (fixture 8).
    const restored = SimulationEngine.fromSnapshot(engine.serialize());
    expect(restored.species.count).toBe(3);
    expect(restored.species.nextSpeciesId).toBe(engine.species.nextSpeciesId);
    for (const record of engine.species.records) {
      const twin = restored.species.get(record.id);
      expect(twin.parentSpeciesId).toBe(record.parentSpeciesId);
      expect(twin.originTick).toBe(record.originTick);
      expect(twin.endTick).toBe(record.endTick);
      expect(twin.endReason).toBe(record.endReason);
      expect(twin.founderEntityId).toBe(record.founderEntityId);
    }
    expect(restored.computeStateHash()).toBe(engine.computeStateHash());
  });

  it("fixture 12: the Tree of Life is acyclic and fully parent-linked", () => {
    const engine = createTwoCloudEngine();
    engine.stepMany(201);

    for (const record of engine.species.records) {
      if (record.id === 1) {
        expect(record.parentSpeciesId).toBe(0);
        continue;
      }
      // Parents strictly precede children, so no walk can ever revisit a node.
      expect(record.parentSpeciesId).toBeGreaterThan(0);
      expect(record.parentSpeciesId).toBeLessThan(record.id);
      // And the chain terminates at the root in finitely many steps.
      let cursor = record.parentSpeciesId;
      let hops = 0;
      while (cursor !== 0) {
        cursor = engine.species.get(cursor).parentSpeciesId;
        hops += 1;
        expect(hops).toBeLessThanOrEqual(engine.species.count);
      }
    }
  });

  it("two independently constructed runs agree at every analysis boundary", () => {
    const first = createTwoCloudEngine();
    const second = createTwoCloudEngine();
    for (const target of [0, 50, 100, 150, 200, 250, 400]) {
      first.stepMany(target - first.tick);
      second.stepMany(target - second.tick);
      expect(`${target}:${first.computeStateHash()}`).toBe(
        `${target}:${second.computeStateHash()}`,
      );
    }
  });
});

describe("snapshot completeness for history state", () => {
  it("restores the event log, detector state and statistics exactly at an arbitrary tick", () => {
    const engine = createTwoCloudEngine();
    engine.stepMany(137); // deliberately NOT an analysis or statistics boundary

    const snapshot = engine.serialize();
    const restored = SimulationEngine.fromSnapshot(snapshot);

    expect(restored.events.events).toEqual(engine.events.events);
    expect(restored.events.nextEventId).toBe(engine.events.nextEventId);
    expect(restored.detectors.capture()).toEqual(engine.detectors.capture());
    expect(restored.stats.capture()).toEqual(engine.stats.capture());
    expect(restored.computeStateHash()).toBe(engine.computeStateHash());
  });

  it("rejects a snapshot whose registry disagrees with the live population", () => {
    const engine = createTwoCloudEngine();
    engine.stepMany(10);
    const snapshot = engine.serialize();
    (snapshot.species.records[0] as { population: number }).population += 1;
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrow(/population/);
  });

  it("rejects a snapshot whose organisms reference an unknown species", () => {
    const engine = createTwoCloudEngine();
    engine.stepMany(10);
    const snapshot = engine.serialize();
    // Point one live organism at a species that does not exist.
    const liveIndex = snapshot.organisms.alive.findIndex((alive) => alive === 1);
    snapshot.organisms.speciesId[liveIndex] = 99;
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrow(/unknown species/);
  });
});
