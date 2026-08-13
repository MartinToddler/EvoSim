import { describe, expect, it } from "vitest";
import { cloneConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { Q, POS_SCALE, ANGLE_STEPS } from "../math/fixed";
import { SimulationEngine } from "../SimulationEngine";
import { TickPhase, type TickPhaseId, type TickProfiler } from "../profiling/TickProfiler";
import { collectTelemetryAggregates, queryEntity } from "./queryEntity";
import {
  RenderFlagBit,
  writeRenderSnapshot,
  writeTerrainFields,
  writeVegetationField,
  type RenderSnapshotWriter,
} from "./renderSnapshot";

/**
 * Render projection and inspection queries (tasks G04/G09).
 *
 * The load-bearing property in this file is the one asserted over and over:
 * **looking at the world does not change it**. A renderer or an inspector that
 * could perturb authoritative state would break determinism in the most
 * insidious way possible — worlds that diverge depending on whether anyone was
 * watching, and headless tests that could never reproduce it.
 */

/**
 * A real engine on a small world.
 *
 * Small because these tests are about projection, not ecology: a 64² grid
 * generates and ticks in a fraction of the time a 256² one does, and every
 * assertion below is about the shape of the projection rather than the size of
 * the world.
 */
function createEngine(seed = 0xe0a12026): SimulationEngine {
  const config = cloneConfig(DEFAULT_CONFIG);
  const gridSize = 64;
  config.world.envGridSize = gridSize;
  config.world.sizeLU = gridSize * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(gridSize / 8));
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 2,
  );
  // The validity thresholds are absolute totals calibrated for the 256² default
  // world, so they must be scaled with the area or a valid small world would be
  // rejected for being small.
  const areaRatio = (gridSize * gridSize) / (256 * 256);
  config.world.validity.minFounderRegionCells = Math.max(
    16,
    Math.floor(config.world.validity.minFounderRegionCells * areaRatio),
  );
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity * areaRatio,
  );
  return new SimulationEngine({ seed, config });
}

function createWriter(organismCapacity: number, carcassCapacity: number): RenderSnapshotWriter {
  return {
    organismId: new Uint32Array(organismCapacity),
    organismX: new Float32Array(organismCapacity),
    organismY: new Float32Array(organismCapacity),
    organismRotation: new Float32Array(organismCapacity),
    organismRadiusLU: new Float32Array(organismCapacity),
    organismSpeciesId: new Uint32Array(organismCapacity),
    organismHueDeg: new Uint16Array(organismCapacity),
    organismFlags: new Uint16Array(organismCapacity),
    organismHealth: new Uint8Array(organismCapacity),
    organismEnergy: new Uint8Array(organismCapacity),
    organismDiet: new Int8Array(organismCapacity),
    organismSpeed: new Uint8Array(organismCapacity),
    carcassId: new Uint32Array(carcassCapacity),
    carcassX: new Float32Array(carcassCapacity),
    carcassY: new Float32Array(carcassCapacity),
    carcassRadiusLU: new Float32Array(carcassCapacity),
  };
}

describe("writeRenderSnapshot", () => {
  it("writes exactly the living population, compacted from ascending slots", () => {
    const engine = createEngine();
    engine.stepMany(50);
    const writer = createWriter(
      engine.config.limits.maxOrganisms,
      engine.config.limits.maxCarcasses,
    );

    const counts = writeRenderSnapshot(engine, writer);
    expect(counts.organismCount).toBe(engine.organisms.liveCount);
    expect(counts.organismCount).toBeGreaterThan(0);
    expect(counts.carcassCount).toBe(engine.carcasses.liveCount);

    // Every written ID is a live entity, and the dense prefix holds no gaps.
    const seen = new Set<number>();
    for (let i = 0; i < counts.organismCount; i += 1) {
      const id = writer.organismId[i] as number;
      expect(id).toBeGreaterThan(0);
      expect(engine.organisms.findSlotByEntityId(id)).toBeGreaterThanOrEqual(0);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it("emits renderer floats in location units and radians", () => {
    const engine = createEngine();
    engine.stepMany(30);
    const writer = createWriter(
      engine.config.limits.maxOrganisms,
      engine.config.limits.maxCarcasses,
    );
    const counts = writeRenderSnapshot(engine, writer);

    const sizeLU = engine.config.world.sizeLU;
    for (let i = 0; i < counts.organismCount; i += 1) {
      const x = writer.organismX[i] as number;
      const y = writer.organismY[i] as number;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(sizeLU);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(sizeLU);

      const rotation = writer.organismRotation[i] as number;
      expect(rotation).toBeGreaterThanOrEqual(0);
      expect(rotation).toBeLessThan(Math.PI * 2);

      expect(writer.organismRadiusLU[i] as number).toBeGreaterThan(0);
      expect(writer.organismHueDeg[i] as number).toBeLessThan(360);
      expect(writer.organismHealth[i] as number).toBeLessThanOrEqual(255);
      expect(writer.organismEnergy[i] as number).toBeLessThanOrEqual(255);
      expect(writer.organismDiet[i] as number).toBeGreaterThanOrEqual(-127);
      expect(writer.organismDiet[i] as number).toBeLessThanOrEqual(127);
    }
  });

  it("agrees with the authoritative row it projects", () => {
    const engine = createEngine();
    engine.stepMany(25);
    const writer = createWriter(
      engine.config.limits.maxOrganisms,
      engine.config.limits.maxCarcasses,
    );
    writeRenderSnapshot(engine, writer);

    const id = writer.organismId[0] as number;
    const slot = engine.organisms.findSlotByEntityId(id);
    expect(writer.organismX[0]).toBeCloseTo((engine.organisms.x[slot] as number) / POS_SCALE, 3);
    expect(writer.organismY[0]).toBeCloseTo((engine.organisms.y[slot] as number) / POS_SCALE, 3);
    expect(writer.organismRotation[0]).toBeCloseTo(
      ((engine.organisms.angle[slot] as number) * Math.PI * 2) / ANGLE_STEPS,
      5,
    );
    expect(writer.organismSpeciesId[0]).toBe(engine.organisms.speciesId[slot]);
  });

  it("sets the juvenile flag exactly when development is below adult", () => {
    const engine = createEngine();
    engine.stepMany(40);
    const writer = createWriter(
      engine.config.limits.maxOrganisms,
      engine.config.limits.maxCarcasses,
    );
    const counts = writeRenderSnapshot(engine, writer);

    for (let i = 0; i < counts.organismCount; i += 1) {
      const slot = engine.organisms.findSlotByEntityId(writer.organismId[i] as number);
      const juvenile = (engine.organisms.developmentQ[slot] as number) < Q;
      const flagged = ((writer.organismFlags[i] as number) & RenderFlagBit.Juvenile) !== 0;
      expect(flagged).toBe(juvenile);
    }
  });

  it("truncates deterministically rather than writing out of bounds", () => {
    const engine = createEngine();
    engine.stepMany(50);
    expect(engine.organisms.liveCount).toBeGreaterThan(4);

    const small = createWriter(4, 2);
    const counts = writeRenderSnapshot(engine, small);
    expect(counts.organismCount).toBe(4);

    // The truncated prefix is the same organisms a full writer would have
    // produced first, because both walk slots in ascending order.
    const full = createWriter(engine.config.limits.maxOrganisms, engine.config.limits.maxCarcasses);
    writeRenderSnapshot(engine, full);
    expect([...small.organismId]).toEqual([...full.organismId.subarray(0, 4)]);
  });

  it("is a pure read: the state hash is unchanged", () => {
    const engine = createEngine();
    engine.stepMany(60);
    const before = engine.computeStateHash();
    const writer = createWriter(
      engine.config.limits.maxOrganisms,
      engine.config.limits.maxCarcasses,
    );

    for (let i = 0; i < 5; i += 1) {
      writeRenderSnapshot(engine, writer);
    }
    expect(engine.computeStateHash()).toBe(before);
    expect(engine.tick).toBe(60);
  });

  it("does not change what the world does next", () => {
    // Stronger than "the hash did not change now": two engines, one observed
    // between every tick and one never observed, must stay identical for the
    // rest of their lives.
    const observed = createEngine();
    const control = createEngine();
    const writer = createWriter(
      observed.config.limits.maxOrganisms,
      observed.config.limits.maxCarcasses,
    );
    for (let tick = 0; tick < 80; tick += 1) {
      writeRenderSnapshot(observed, writer);
      observed.step();
      control.step();
    }
    expect(observed.computeStateHash()).toBe(control.computeStateHash());
  });
});

describe("writeVegetationField and writeTerrainFields", () => {
  it("reports biomass as a fraction of each cell's own capacity", () => {
    const engine = createEngine();
    engine.stepMany(40);
    const field = new Uint8Array(engine.environment.cellCount);
    writeVegetationField(engine, field);

    for (let cell = 0; cell < engine.environment.cellCount; cell += 1) {
      const capacity = engine.environment.plantCapacity[cell] as number;
      if (capacity <= 0) {
        // Water has no capacity; a fraction of zero is zero, not NaN.
        expect(field[cell]).toBe(0);
        continue;
      }
      const expected = Math.round(
        ((engine.environment.plantBiomass[cell] as number) * 255) / capacity,
      );
      expect(field[cell]).toBe(Math.min(255, Math.max(0, expected)));
    }
  });

  it("copies biome indices verbatim and rescales elevation to a byte", () => {
    const engine = createEngine();
    const biome = new Uint8Array(engine.environment.cellCount);
    const elevation = new Uint8Array(engine.environment.cellCount);
    writeTerrainFields(engine, biome, elevation);

    expect([...biome]).toEqual([...engine.environment.biome]);
    for (let cell = 0; cell < engine.environment.cellCount; cell += 1) {
      expect(elevation[cell]).toBe(
        Math.round(((engine.environment.elevationQ[cell] as number) * 255) / Q),
      );
    }
  });

  it("leaves the state hash untouched", () => {
    const engine = createEngine();
    engine.stepMany(20);
    const before = engine.computeStateHash();
    writeVegetationField(engine, new Uint8Array(engine.environment.cellCount));
    writeTerrainFields(
      engine,
      new Uint8Array(engine.environment.cellCount),
      new Uint8Array(engine.environment.cellCount),
    );
    expect(engine.computeStateHash()).toBe(before);
  });

  it("tolerates an output array smaller than the grid", () => {
    const engine = createEngine();
    const field = new Uint8Array(10);
    expect(() => {
      writeVegetationField(engine, field);
    }).not.toThrow();
  });
});

describe("queryEntity", () => {
  it("answers with human units for a living organism", () => {
    const engine = createEngine();
    engine.stepMany(30);
    const writer = createWriter(
      engine.config.limits.maxOrganisms,
      engine.config.limits.maxCarcasses,
    );
    writeRenderSnapshot(engine, writer);
    const id = writer.organismId[0] as number;

    const details = queryEntity(engine, id);
    expect(details).not.toBeNull();
    if (details === null) {
      return;
    }
    expect(details.entityId).toBe(id);
    expect(details.health).toBeGreaterThan(0);
    expect(details.health).toBeLessThanOrEqual(1);
    expect(details.development).toBeGreaterThan(0);
    expect(details.development).toBeLessThanOrEqual(1);
    expect(details.diet).toBeGreaterThanOrEqual(-1);
    expect(details.diet).toBeLessThanOrEqual(1);
    expect(details.visionFovDegrees).toBeGreaterThan(0);
    expect(details.visionFovDegrees).toBeLessThanOrEqual(360);
    expect(details.maxEnergy).toBeGreaterThan(0);
    expect(details.biomeName.length).toBeGreaterThan(0);
    expect(Number.isFinite(details.cellTemperatureC)).toBe(true);
  });

  it("returns null for an entity that never existed", () => {
    const engine = createEngine();
    expect(queryEntity(engine, 0)).toBeNull();
    expect(queryEntity(engine, 999_999)).toBeNull();
  });

  it("returns null once the selected organism dies", () => {
    // The exact race the UI hits: something was selected from a snapshot, and
    // by the time the query is answered it is gone. That is an ordinary
    // outcome of a live world, so it must be an answer, not a throw.
    const engine = createEngine();
    engine.stepMany(10);
    const writer = createWriter(
      engine.config.limits.maxOrganisms,
      engine.config.limits.maxCarcasses,
    );
    const counts = writeRenderSnapshot(engine, writer);
    const ids: number[] = [];
    for (let i = 0; i < counts.organismCount; i += 1) {
      ids.push(writer.organismId[i] as number);
    }

    // Run until the world has actually killed something, rather than guessing a
    // tick count that would be either flaky or needlessly slow.
    for (let i = 0; i < 200 && engine.organisms.totalDeaths === 0; i += 1) {
      engine.stepMany(25);
    }
    expect(engine.organisms.totalDeaths).toBeGreaterThan(0);
    const dead = ids.filter((id) => engine.organisms.findSlotByEntityId(id) < 0);
    expect(dead.length).toBeGreaterThan(0);
    for (const id of dead.slice(0, 5)) {
      expect(queryEntity(engine, id)).toBeNull();
    }
  });

  it("is a pure read: the state hash is unchanged", () => {
    const engine = createEngine();
    engine.stepMany(30);
    const before = engine.computeStateHash();
    for (let id = 1; id <= 40; id += 1) {
      queryEntity(engine, id);
    }
    collectTelemetryAggregates(engine);
    expect(engine.computeStateHash()).toBe(before);
  });
});

describe("collectTelemetryAggregates", () => {
  it("agrees with the stores it summarizes", () => {
    const engine = createEngine();
    engine.stepMany(40);
    const aggregates = collectTelemetryAggregates(engine);

    expect(aggregates.population).toBe(engine.organisms.liveCount);
    let biomass = 0;
    let capacity = 0;
    for (let cell = 0; cell < engine.environment.cellCount; cell += 1) {
      biomass += engine.environment.plantBiomass[cell] as number;
      capacity += engine.environment.plantCapacity[cell] as number;
    }
    expect(aggregates.plantBiomass).toBe(biomass);
    expect(aggregates.plantCapacity).toBe(capacity);
    expect(aggregates.maxGeneration).toBeGreaterThanOrEqual(0);
  });
});

describe("tick profiler", () => {
  it("observes every phase boundary in matched pairs", () => {
    const engine = createEngine();
    const opened: TickPhaseId[] = [];
    const closed: TickPhaseId[] = [];
    const profiler: TickProfiler = {
      begin: (phase) => opened.push(phase),
      end: (phase) => closed.push(phase),
    };
    engine.setProfiler(profiler);
    engine.step();

    expect(opened).toEqual(closed);
    expect(opened).toContain(TickPhase.SpatialRebuild);
    expect(opened).toContain(TickPhase.Sensing);
    expect(opened).toContain(TickPhase.Brain);
    expect(opened).toContain(TickPhase.Movement);
    expect(opened).toContain(TickPhase.Feeding);
    expect(opened).toContain(TickPhase.Combat);
    expect(opened).toContain(TickPhase.MetabolismDeath);
    expect(opened).toContain(TickPhase.Reproduction);
    // Tick 0 runs the scheduled phases too.
    expect(opened).toContain(TickPhase.Environment);
    expect(opened).toContain(TickPhase.Carcasses);
  });

  it("cannot change the simulation it measures", () => {
    // The profiler is the one piece of mutable state on a frozen engine, so
    // this is the assertion that keeps it honest: a profiled world and an
    // unprofiled one are the same world.
    const profiled = createEngine();
    const plain = createEngine();
    profiled.setProfiler({
      begin: () => undefined,
      end: () => undefined,
    });
    profiled.stepMany(120);
    plain.stepMany(120);
    expect(profiled.computeStateHash()).toBe(plain.computeStateHash());
  });

  it("can be detached again", () => {
    const engine = createEngine();
    let calls = 0;
    engine.setProfiler({
      begin: () => {
        calls += 1;
      },
      end: () => undefined,
    });
    engine.step();
    const afterAttached = calls;
    expect(afterAttached).toBeGreaterThan(0);
    engine.setProfiler(null);
    engine.step();
    expect(calls).toBe(afterAttached);
  });
});
