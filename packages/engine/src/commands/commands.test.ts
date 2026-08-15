import { describe, expect, it } from "vitest";
import { Q } from "../math/fixed";
import { DeathCause } from "../organisms/death";
import { EventSeverity, WorldEventType } from "../history/EventStore";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import { Biome } from "../world/biomes";
import { CommandLog, CommandLogSnapshotError } from "./CommandLog";
import { applyCommandsForTick } from "./applyCommands";
import {
  BrushFalloff,
  COMMAND_SCHEMA_VERSION,
  CommandRejectReason,
  InterventionKind,
  validateCommandInput,
  type BrushInput,
  type CommandInput,
} from "./SimulationCommand";

/**
 * Command log, validation and applier unit tests (tasks J01, J03–J07).
 *
 * Engine-level behavior — queue/step integration, hashing, snapshots, replay —
 * lives in `commandSimulation.test.ts`. Here each applier runs against the
 * synthetic flat world, so every assertion is against exact integer values on
 * known terrain instead of whatever a seed generated.
 */

/** Queue a validated input through a log and apply it at `tick`. */
function applyNow(world: TestWorld, log: CommandLog, input: CommandInput, tick: number): void {
  const problem = validateCommandInput(input, world.config);
  expect(problem).toBeNull();
  log.accept(input, tick);
  applyCommandsForTick(world.ctx, log, tick);
}

function brush(overrides: Partial<BrushInput> & { kind: BrushInput["kind"] }): BrushInput {
  return {
    radiusLU: 16,
    strength: 100,
    falloff: BrushFalloff.Hard,
    samplesXLU: [512],
    samplesYLU: [512],
    ...overrides,
  };
}

describe("command input validation", () => {
  const world = createTestWorld();

  it("accepts every well-formed kind", () => {
    expect(
      validateCommandInput(
        { kind: InterventionKind.SetGlobalTemperature, offsetCentiC: -500 },
        world.config,
      ),
    ).toBeNull();
    expect(
      validateCommandInput(brush({ kind: InterventionKind.PaintTemperature }), world.config),
    ).toBeNull();
    expect(
      validateCommandInput(
        { kind: InterventionKind.Meteor, centerXLU: 500, centerYLU: 500, radiusLU: 32 },
        world.config,
      ),
    ).toBeNull();
  });

  it("rejects non-integer payload fields as malformed", () => {
    const result = validateCommandInput(
      brush({ kind: InterventionKind.PaintMoisture, strength: 10.5 }),
      world.config,
    );
    expect(result?.reason).toBe(CommandRejectReason.Malformed);
  });

  it("rejects mismatched or empty sample arrays as malformed", () => {
    expect(
      validateCommandInput(
        brush({ kind: InterventionKind.PaintMoisture, samplesXLU: [1, 2], samplesYLU: [1] }),
        world.config,
      )?.reason,
    ).toBe(CommandRejectReason.Malformed);
    expect(
      validateCommandInput(
        brush({ kind: InterventionKind.PaintMoisture, samplesXLU: [], samplesYLU: [] }),
        world.config,
      )?.reason,
    ).toBe(CommandRejectReason.Malformed);
  });

  it("rejects an unknown falloff as malformed", () => {
    expect(
      validateCommandInput(
        brush({ kind: InterventionKind.PaintMoisture, falloff: 3 as BrushFalloff }),
        world.config,
      )?.reason,
    ).toBe(CommandRejectReason.Malformed);
  });

  it("rejects out-of-bounds radius, strength, sample count and coordinates", () => {
    const bounds = world.config.interventions;
    expect(
      validateCommandInput(
        brush({ kind: InterventionKind.PaintMoisture, radiusLU: bounds.maxBrushRadiusLU + 1 }),
        world.config,
      )?.reason,
    ).toBe(CommandRejectReason.OutOfBounds);
    expect(
      validateCommandInput(
        brush({
          kind: InterventionKind.PaintMoisture,
          strength: bounds.maxMoistureBrushStrengthQ + 1,
        }),
        world.config,
      )?.reason,
    ).toBe(CommandRejectReason.OutOfBounds);
    const tooMany = bounds.maxBrushSamplesPerCommand + 1;
    expect(
      validateCommandInput(
        brush({
          kind: InterventionKind.PaintMoisture,
          samplesXLU: new Array<number>(tooMany).fill(10),
          samplesYLU: new Array<number>(tooMany).fill(10),
        }),
        world.config,
      )?.reason,
    ).toBe(CommandRejectReason.OutOfBounds);
    expect(
      validateCommandInput(
        brush({ kind: InterventionKind.PaintMoisture, samplesXLU: [-1], samplesYLU: [0] }),
        world.config,
      )?.reason,
    ).toBe(CommandRejectReason.OutOfBounds);
  });

  it("rejects zero strength, and negative strength for direction-in-kind brushes", () => {
    expect(
      validateCommandInput(brush({ kind: InterventionKind.AddBiomass, strength: 0 }), world.config)
        ?.reason,
    ).toBe(CommandRejectReason.OutOfBounds);
    expect(
      validateCommandInput(
        brush({ kind: InterventionKind.RaiseTerrain, strength: -50 }),
        world.config,
      )?.reason,
    ).toBe(CommandRejectReason.OutOfBounds);
    // Signed kinds accept a negative strength: cooling, drying, depleting.
    expect(
      validateCommandInput(
        brush({ kind: InterventionKind.PaintTemperature, strength: -100 }),
        world.config,
      ),
    ).toBeNull();
  });

  it("rejects a global offset beyond its bound and a meteor outside its radius band", () => {
    const bounds = world.config.interventions;
    expect(
      validateCommandInput(
        {
          kind: InterventionKind.SetGlobalTemperature,
          offsetCentiC: bounds.maxGlobalTemperatureOffsetCentiC + 1,
        },
        world.config,
      )?.reason,
    ).toBe(CommandRejectReason.OutOfBounds);
    expect(
      validateCommandInput(
        {
          kind: InterventionKind.Meteor,
          centerXLU: 100,
          centerYLU: 100,
          radiusLU: bounds.meteor.minRadiusLU - 1,
        },
        world.config,
      )?.reason,
    ).toBe(CommandRejectReason.OutOfBounds);
  });
});

describe("command log", () => {
  const input: CommandInput = { kind: InterventionKind.SetGlobalTemperature, offsetCentiC: 100 };

  it("stamps monotonic ids and sequences and freezes accepted commands", () => {
    const log = new CommandLog();
    const a = log.accept(input, 5);
    const b = log.accept(input, 5);
    expect([a.id, b.id]).toEqual([1, 2]);
    expect([a.sequence, b.sequence]).toEqual([1, 2]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as { offsetCentiC: number }).offsetCentiC = 999;
    }).toThrow(TypeError);
  });

  it("keeps the pending suffix (tick, sequence)-sorted when a later acceptance targets an earlier tick", () => {
    const log = new CommandLog();
    const late = log.accept(input, 100);
    const early = log.accept(input, 60);
    expect(log.at(0)).toBe(early);
    expect(log.at(1)).toBe(late);
    // Identity still records acceptance order.
    expect(early.sequence).toBeGreaterThan(late.sequence);
  });

  it("round-trips through capture/restore", () => {
    const log = new CommandLog();
    log.accept(input, 3);
    log.accept(
      {
        kind: InterventionKind.PaintMoisture,
        radiusLU: 8,
        strength: 64,
        falloff: BrushFalloff.Linear,
        samplesXLU: [10, 20],
        samplesYLU: [10, 20],
      },
      4,
    );
    const restored = new CommandLog();
    restored.restore(log.capture());
    expect(restored.capture()).toEqual(log.capture());
  });

  it("rejects duplicate command ids on restore", () => {
    const log = new CommandLog();
    log.accept(input, 3);
    log.accept(input, 4);
    const snapshot = log.capture();
    snapshot.commands[1] = { ...snapshot.commands[1]!, id: snapshot.commands[0]!.id };
    expect(() => new CommandLog().restore(snapshot)).toThrow(CommandLogSnapshotError);
    expect(() => new CommandLog().restore(snapshot)).toThrow(/duplicates command id/);
  });

  it("rejects duplicate sequences and (tick, sequence) disorder on restore", () => {
    const log = new CommandLog();
    log.accept(input, 3);
    log.accept(input, 3);
    const duplicated = log.capture();
    duplicated.commands[1] = {
      ...duplicated.commands[1]!,
      sequence: duplicated.commands[0]!.sequence,
    };
    expect(() => new CommandLog().restore(duplicated)).toThrow(/duplicates sequence/);

    const disordered = log.capture();
    // Swap application order without touching identity: strictly decreasing tick.
    disordered.commands[0] = { ...disordered.commands[0]!, tick: 9 };
    expect(() => new CommandLog().restore(disordered)).toThrow(
      /strictly \(tick, sequence\)-ordered/,
    );
  });

  it("rejects an out-of-range cursor and unknown schema versions on restore", () => {
    const log = new CommandLog();
    log.accept(input, 3);
    const badCursor = log.capture();
    badCursor.cursor = 2;
    expect(() => new CommandLog().restore(badCursor)).toThrow(/cursor/);

    const badSchema = log.capture();
    badSchema.commands[0] = {
      ...badSchema.commands[0]!,
      schemaVersion: (COMMAND_SCHEMA_VERSION + 1) as 1,
    };
    expect(() => new CommandLog().restore(badSchema)).toThrow(/schema/);
  });
});

describe("brush appliers", () => {
  function freshWorld(): TestWorld {
    return createTestWorld({ gridSize: 64 });
  }

  it("paints a temperature offset with hard falloff over exactly the cells in radius, row-major", () => {
    const world = freshWorld();
    const log = new CommandLog();
    const cell = world.environment.cellSizeLU; // 16 LU
    // Centre of cell (32, 32) is at (520, 520); radius one cell.
    applyNow(
      world,
      log,
      brush({
        kind: InterventionKind.PaintTemperature,
        strength: 200,
        radiusLU: cell,
        falloff: BrushFalloff.Hard,
        samplesXLU: [32 * cell + cell / 2],
        samplesYLU: [32 * cell + cell / 2],
      }),
      0,
    );
    // Hard falloff: full delta on the 4-neighbourhood and centre (the corner
    // cells are sqrt(2) cell-widths away, outside radius = 1 cell).
    const offsets = world.environment.temperatureOffsetCentiC;
    const index = (gx: number, gy: number): number => world.environment.cellIndex(gx, gy);
    expect(offsets[index(32, 32)]).toBe(200);
    expect(offsets[index(31, 32)]).toBe(200);
    expect(offsets[index(33, 32)]).toBe(200);
    expect(offsets[index(32, 31)]).toBe(200);
    expect(offsets[index(32, 33)]).toBe(200);
    expect(offsets[index(31, 31)]).toBe(0);
    expect(offsets[index(30, 32)]).toBe(0);
  });

  it("linear falloff scales the delta down with distance and reaches full strength at the centre", () => {
    const world = freshWorld();
    const log = new CommandLog();
    const cell = world.environment.cellSizeLU;
    applyNow(
      world,
      log,
      brush({
        kind: InterventionKind.PaintTemperature,
        strength: 400,
        radiusLU: 4 * cell,
        falloff: BrushFalloff.Linear,
        samplesXLU: [32 * cell + cell / 2],
        samplesYLU: [32 * cell + cell / 2],
      }),
      0,
    );
    const offsets = world.environment.temperatureOffsetCentiC;
    const centre = offsets[world.environment.cellIndex(32, 32)] as number;
    const oneOut = offsets[world.environment.cellIndex(33, 32)] as number;
    const threeOut = offsets[world.environment.cellIndex(35, 32)] as number;
    expect(centre).toBe(400);
    expect(oneOut).toBe(300); // (4-1)/4 of 400
    expect(threeOut).toBe(100); // (4-3)/4 of 400
    expect(oneOut).toBeGreaterThan(threeOut);
  });

  it("applies each cell at most once per command, however densely samples overlap", () => {
    const world = freshWorld();
    const log = new CommandLog();
    const cell = world.environment.cellSizeLU;
    const centre = 32 * cell + cell / 2;
    applyNow(
      world,
      log,
      brush({
        kind: InterventionKind.PaintTemperature,
        strength: 200,
        radiusLU: 2 * cell,
        falloff: BrushFalloff.Hard,
        // Five samples on the same point: one application, not five.
        samplesXLU: [centre, centre, centre, centre, centre],
        samplesYLU: [centre, centre, centre, centre, centre],
      }),
      0,
    );
    expect(world.environment.temperatureOffsetCentiC[world.environment.cellIndex(32, 32)]).toBe(
      200,
    );
  });

  it("accumulates across commands and saturates at the local offset bound", () => {
    const world = freshWorld();
    const log = new CommandLog();
    const bound = world.config.interventions.maxLocalTemperatureOffsetCentiC;
    const strength = world.config.interventions.maxTemperatureBrushStrengthCentiC;
    const passes = Math.ceil(bound / strength) + 3;
    for (let i = 0; i < passes; i += 1) {
      applyNow(
        world,
        log,
        brush({ kind: InterventionKind.PaintTemperature, strength, falloff: BrushFalloff.Hard }),
        i,
      );
    }
    const index = world.environment.cellIndexFromPosition(512 * 256, 512 * 256);
    expect(world.environment.temperatureOffsetCentiC[index]).toBe(bound);
  });

  it("moisture and fertility brushes clamp to their ranges and recompute the biome", () => {
    const world = freshWorld();
    const log = new CommandLog();
    const index = world.environment.cellIndexFromPosition(512 * 256, 512 * 256);
    // The harness world is uniform grassland: moisture 2048, fertility 2048.
    // Push moisture and fertility above the forest thresholds (2540 / 2253).
    applyNow(
      world,
      log,
      brush({ kind: InterventionKind.PaintMoisture, strength: 512, falloff: BrushFalloff.Hard }),
      0,
    );
    applyNow(
      world,
      log,
      brush({ kind: InterventionKind.PaintMoisture, strength: 512, falloff: BrushFalloff.Hard }),
      1,
    );
    applyNow(
      world,
      log,
      brush({ kind: InterventionKind.PaintFertility, strength: 512, falloff: BrushFalloff.Hard }),
      2,
    );
    expect(world.environment.moistureOffsetQ[index]).toBe(1024);
    expect(world.environment.getMoistureQ(index)).toBe(3072);
    expect(world.environment.fertilityQ[index]).toBe(2560);
    // Dependent data recomputed deterministically: grassland became forest,
    // and the capacity followed the new biome's base.
    expect(world.environment.biome[index]).toBe(Biome.Forest);
    expect(world.environment.plantCapacity[index]).toBeGreaterThan(0);
  });

  it("terrain lowering floods a cell: water biome, impassable, plants gone — organisms untouched", () => {
    const world = freshWorld();
    const log = new CommandLog();
    const { xPos, yPos } = world.cellCenter(32, 32);
    const slot = spawnTestOrganism(world, { xPos, yPos });
    expect(slot).toBeGreaterThanOrEqual(0);

    const index = world.environment.cellIndex(32, 32);
    const seaLevel = world.config.world.seaLevelQ;
    expect(world.environment.elevationQ[index]).toBeGreaterThanOrEqual(seaLevel);

    const strength = world.config.interventions.maxTerrainBrushStrengthQ;
    const passes = Math.ceil((Q / 2 - seaLevel) / strength) + 2;
    for (let i = 0; i < passes; i += 1) {
      applyNow(
        world,
        log,
        brush({
          kind: InterventionKind.LowerTerrain,
          strength,
          radiusLU: 16,
          falloff: BrushFalloff.Hard,
          samplesXLU: [32 * 16 + 8],
          samplesYLU: [32 * 16 + 8],
        }),
        i,
      );
    }

    expect(world.environment.elevationQ[index]).toBeLessThan(seaLevel);
    expect(world.environment.biome[index]).toBe(Biome.Water);
    expect(world.environment.passable[index]).toBe(0);
    expect(world.environment.plantCapacity[index]).toBe(0);
    expect(world.environment.plantBiomass[index]).toBe(0);
    // docs/03 §25: organisms on newly flooded cells are NOT deleted; the water
    // rules take over on later ticks.
    expect(world.organisms.alive[slot]).toBe(1);
    expect(world.organisms.healthQ[slot]).toBe(Q);
  });

  it("terrain raising drains a water cell back to land", () => {
    const world = freshWorld();
    world.makeWater(20, 20);
    const index = world.environment.cellIndex(20, 20);
    // A real water cell sits below sea level; the harness helper only flips
    // the biome, so pin the elevation down as generation would have.
    world.environment.elevationQ[index] = 0;
    expect(world.environment.biome[index]).toBe(Biome.Water);

    const log = new CommandLog();
    const strength = world.config.interventions.maxTerrainBrushStrengthQ;
    // Climb from the sea floor back above sea level.
    const passes = Math.ceil(world.config.world.seaLevelQ / strength) + 1;
    for (let i = 0; i < passes; i += 1) {
      applyNow(
        world,
        log,
        brush({
          kind: InterventionKind.RaiseTerrain,
          strength,
          radiusLU: 16,
          falloff: BrushFalloff.Hard,
          samplesXLU: [20 * 16 + 8],
          samplesYLU: [20 * 16 + 8],
        }),
        i,
      );
    }
    expect(world.environment.biome[index]).not.toBe(Biome.Water);
    expect(world.environment.passable[index]).toBe(1);
  });

  it("biomass add overfills only to the configured multiple of capacity and never onto water", () => {
    const world = freshWorld();
    const log = new CommandLog();
    const index = world.environment.cellIndexFromPosition(512 * 256, 512 * 256);
    const capacity = world.environment.plantCapacity[index] as number;
    const ceiling = Math.min(
      65535,
      Math.trunc((capacity * world.config.interventions.biomassOverfillLimitQ) / Q),
    );
    const strength = world.config.interventions.maxBiomassBrushStrengthUnits;
    for (let i = 0; i < 40; i += 1) {
      applyNow(
        world,
        log,
        brush({ kind: InterventionKind.AddBiomass, strength, falloff: BrushFalloff.Hard }),
        i,
      );
    }
    expect(world.environment.plantBiomass[index]).toBe(ceiling);
    expect(world.environment.plantBiomass[index]).toBeGreaterThan(capacity);

    world.makeWater(10, 10);
    const water = world.environment.cellIndex(10, 10);
    applyNow(
      world,
      log,
      brush({
        kind: InterventionKind.AddBiomass,
        strength,
        falloff: BrushFalloff.Hard,
        samplesXLU: [10 * 16 + 8],
        samplesYLU: [10 * 16 + 8],
      }),
      100,
    );
    expect(world.environment.plantBiomass[water]).toBe(0);
  });

  it("biomass remove floors at zero and clears the growth carry", () => {
    const world = freshWorld();
    const log = new CommandLog();
    const index = world.environment.cellIndexFromPosition(512 * 256, 512 * 256);
    world.environment.plantGrowthRemainderQ[index] = 1000;
    const before = world.environment.plantBiomass[index] as number;
    const strength = world.config.interventions.maxBiomassBrushStrengthUnits;
    const passes = Math.ceil(before / strength) + 1;
    for (let i = 0; i < passes; i += 1) {
      applyNow(
        world,
        log,
        brush({ kind: InterventionKind.RemoveBiomass, strength, falloff: BrushFalloff.Hard }),
        i,
      );
    }
    expect(world.environment.plantBiomass[index]).toBe(0);
    expect(world.environment.plantGrowthRemainderQ[index]).toBe(0);
  });

  it("appends exactly one PlayerIntervention event per command with the stroke's region", () => {
    const world = freshWorld();
    const log = new CommandLog();
    applyNow(
      world,
      log,
      brush({
        kind: InterventionKind.PaintMoisture,
        strength: 200,
        samplesXLU: [400, 500, 600],
        samplesYLU: [400, 400, 400],
      }),
      7,
    );
    const events = world.ctx.events.capture().events;
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe(WorldEventType.PlayerIntervention);
    expect(event.severity).toBe(EventSeverity.Notable);
    expect(event.tick).toBe(7);
    expect(event.payload[0]).toBe(InterventionKind.PaintMoisture);
    expect(event.payload[1]).toBe(1); // command id
    expect(event.regionXPos).toBe(500 * 256);
    expect(event.regionRadiusPos).toBeGreaterThanOrEqual((100 + 16) * 256);
  });
});

describe("global temperature applier", () => {
  it("sets the absolute offset, recomputes every cell and logs one event", () => {
    const world = createTestWorld({ gridSize: 64, temperatureCentiC: -250 });
    // Uniform -2.5°C world: grassland by default thresholds (tundra needs -3°C).
    const anyCell = world.environment.cellIndex(5, 5);
    expect(world.environment.biome[anyCell]).toBe(Biome.Grassland);

    const log = new CommandLog();
    const input: CommandInput = { kind: InterventionKind.SetGlobalTemperature, offsetCentiC: -100 };
    expect(validateCommandInput(input, world.config)).toBeNull();
    log.accept(input, 0);
    applyCommandsForTick(world.ctx, log, 0);

    expect(world.environment.globalTemperatureOffsetCentiC).toBe(-100);
    expect(world.environment.getTemperatureCentiC(anyCell)).toBe(-350);
    // Effective temperature fell below the tundra threshold everywhere; the
    // whole-grid recompute reclassified every land cell.
    expect(world.environment.biome[anyCell]).toBe(Biome.Tundra);
    const events = world.ctx.events.capture().events;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual([InterventionKind.SetGlobalTemperature, 1, -100, 0]);

    // A second command REPLACES the offset (absolute set, not additive).
    log.accept({ kind: InterventionKind.SetGlobalTemperature, offsetCentiC: 400 }, 1);
    applyCommandsForTick(world.ctx, log, 1);
    expect(world.environment.globalTemperatureOffsetCentiC).toBe(400);
    expect(world.environment.biome[anyCell]).toBe(Biome.Grassland);
  });
});

describe("meteor applier", () => {
  it("damages by distance, kills at the core, wounds at the rim, and craters the terrain", () => {
    const world = createTestWorld({ gridSize: 64 });
    const centre = world.cellCenter(32, 32);
    const radius = world.config.interventions.meteor.minRadiusLU; // 24 LU
    const atCore = spawnTestOrganism(world, { xPos: centre.xPos, yPos: centre.yPos });
    // 20 LU out with radius 24: factor trunc(4096*(6144-5120)/6144) = 682,
    // damage trunc(8192*682/4096) = 1364.
    const atRim = spawnTestOrganism(world, {
      xPos: centre.xPos + 20 * 256,
      yPos: centre.yPos,
    });
    const outside = spawnTestOrganism(world, {
      xPos: centre.xPos + 30 * 256,
      yPos: centre.yPos,
    });

    const index = world.environment.cellIndex(32, 32);
    const elevationBefore = world.environment.elevationQ[index] as number;
    const fertilityBefore = world.environment.fertilityQ[index] as number;
    const biomassBefore = world.environment.plantBiomass[index] as number;

    const log = new CommandLog();
    const input: CommandInput = {
      kind: InterventionKind.Meteor,
      centerXLU: centre.xPos / 256,
      centerYLU: centre.yPos / 256,
      radiusLU: radius,
    };
    expect(validateCommandInput(input, world.config)).toBeNull();
    log.accept(input, 12);
    applyCommandsForTick(world.ctx, log, 12);

    // Core organism: 8192 damage against 4096 health — dead, cause Meteor.
    expect(world.organisms.healthQ[atCore]).toBe(0);
    expect(world.ctx.scratch.pendingDeath[atCore]).toBe(1);
    expect(world.ctx.scratch.deathCause[atCore]).toBe(DeathCause.Meteor);
    // Rim organism: wounded exactly by the linear falloff share, alive.
    expect(world.organisms.healthQ[atRim]).toBe(Q - 1364);
    expect(world.ctx.scratch.pendingDeath[atRim]).toBe(0);
    // Outside the radius: untouched.
    expect(world.organisms.healthQ[outside]).toBe(Q);

    // Environment: biomass lost, terrain depressed, soil scorched at centre.
    expect(world.environment.plantBiomass[index]).toBeLessThan(biomassBefore);
    expect(world.environment.elevationQ[index]).toBeLessThan(elevationBefore);
    expect(world.environment.fertilityQ[index]).toBeLessThan(fertilityBefore);

    // One MAJOR event carrying the crater region and the kill count.
    const events = world.ctx.events.capture().events;
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe(EventSeverity.Major);
    expect(events[0]!.regionRadiusPos).toBe(radius * 256);
    expect(events[0]!.payload).toEqual([InterventionKind.Meteor, 1, radius, 1]);
  });

  it("a deep enough depression floods the crater", () => {
    const world = createTestWorld({
      gridSize: 64,
      configure: (config) => {
        config.interventions.meteor.depressionQ = 4096;
      },
    });
    const index = world.environment.cellIndex(32, 32);
    expect(world.environment.biome[index]).toBe(Biome.Grassland);
    const log = new CommandLog();
    log.accept(
      {
        kind: InterventionKind.Meteor,
        centerXLU: 32 * 16 + 8,
        centerYLU: 32 * 16 + 8,
        radiusLU: 48,
      },
      0,
    );
    applyCommandsForTick(world.ctx, log, 0);
    expect(world.environment.biome[index]).toBe(Biome.Water);
    expect(world.environment.passable[index]).toBe(0);
    expect(world.environment.plantBiomass[index]).toBe(0);
  });
});

describe("applyCommandsForTick", () => {
  it("applies only commands for the executing tick, in (tick, sequence) order", () => {
    const world = createTestWorld();
    const log = new CommandLog();
    const index = world.environment.cellIndexFromPosition(512 * 256, 512 * 256);
    world.environment.plantBiomass[index] = 100;

    // Same tick: remove 3000 (floors 100 at 0), then add 500 -> 500. In the
    // other order the result would be 0 (100+500 = 600, then -3000 floors at
    // 0), so sequence order is observable.
    log.accept(brush({ kind: InterventionKind.RemoveBiomass, strength: 3000 }), 5);
    log.accept(brush({ kind: InterventionKind.AddBiomass, strength: 500 }), 5);
    // A later tick's command must NOT apply yet.
    log.accept(brush({ kind: InterventionKind.AddBiomass, strength: 500 }), 6);

    applyCommandsForTick(world.ctx, log, 4);
    expect(world.environment.plantBiomass[index]).toBe(100);
    expect(log.cursor).toBe(0);

    applyCommandsForTick(world.ctx, log, 5);
    expect(world.environment.plantBiomass[index]).toBe(500);
    expect(log.cursor).toBe(2);
    expect(log.pendingCount).toBe(1);

    applyCommandsForTick(world.ctx, log, 6);
    expect(world.environment.plantBiomass[index]).toBe(1000);
    expect(log.pendingCount).toBe(0);
    expect(world.ctx.events.capture().events).toHaveLength(3);
  });
});
