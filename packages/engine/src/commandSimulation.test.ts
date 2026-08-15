import { describe, expect, it } from "vitest";
import { SimulationEngine } from "./SimulationEngine";
import {
  BrushFalloff,
  CommandRejectReason,
  InterventionKind,
  type CommandInput,
} from "./commands/SimulationCommand";
import { cloneConfig, type ReadonlySimulationConfig } from "./config/cloneConfig";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import { WorldEventType } from "./history/EventStore";
import { recomputeDerivedRegion } from "./world/recomputeRegion";

/**
 * Engine-level command acceptance tests (tasks J01–J08, docs/07 Milestone 9):
 * identical command streams reproduce identical hashes, ordering is
 * `(tick, sequence)`, snapshots carry the cursor so nothing applies twice, and
 * a recorded log replays a session exactly.
 *
 * These run on a small real world — generated terrain, live founders — because
 * what they pin is the integration: queue → phase 0 → ecology → hash. Applier
 * arithmetic is pinned per-kind in `commands/commands.test.ts` on the synthetic
 * flat world.
 */

const SMALL_GRID = 96;

/** DEFAULT_CONFIG biology on a 96x96 world (the soak geometry). */
const SMALL_CONFIG: ReadonlySimulationConfig = (() => {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.envGridSize = SMALL_GRID;
  config.world.sizeLU = SMALL_GRID * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(SMALL_GRID / 8));
  config.world.initialOrganisms = 64;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.world.validity.minFounderRegionCells = Math.floor((SMALL_GRID * SMALL_GRID) / 8);
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity / 16,
  );
  return config;
})();

const SEED = 0xe0a12026;

function smallWorld(): SimulationEngine {
  return new SimulationEngine({ seed: SEED, config: SMALL_CONFIG });
}

/** The founder region centre in LU — terrain guaranteed to be land. */
function founderCentreLU(engine: SimulationEngine): { x: number; y: number } {
  const cell = engine.environment.cellSizeLU;
  return {
    x: engine.founderRegion.centerGridX * cell + cell / 2,
    y: engine.founderRegion.centerGridY * cell + cell / 2,
  };
}

/** One command of every kind, aimed at the world's founder region. */
function everyKind(engine: SimulationEngine): CommandInput[] {
  const { x, y } = founderCentreLU(engine);
  return [
    { kind: InterventionKind.SetGlobalTemperature, offsetCentiC: 250 },
    {
      kind: InterventionKind.PaintTemperature,
      radiusLU: 32,
      strength: 200,
      falloff: BrushFalloff.Linear,
      samplesXLU: [x, x + 16],
      samplesYLU: [y, y],
    },
    {
      kind: InterventionKind.PaintMoisture,
      radiusLU: 32,
      strength: -256,
      falloff: BrushFalloff.Linear,
      samplesXLU: [x],
      samplesYLU: [y + 16],
    },
    {
      kind: InterventionKind.PaintFertility,
      radiusLU: 24,
      strength: 256,
      falloff: BrushFalloff.Hard,
      samplesXLU: [x - 16],
      samplesYLU: [y],
    },
    {
      kind: InterventionKind.RaiseTerrain,
      radiusLU: 16,
      strength: 128,
      falloff: BrushFalloff.Hard,
      samplesXLU: [x + 32],
      samplesYLU: [y + 32],
    },
    {
      kind: InterventionKind.LowerTerrain,
      radiusLU: 16,
      strength: 128,
      falloff: BrushFalloff.Linear,
      samplesXLU: [x - 32],
      samplesYLU: [y - 32],
    },
    {
      kind: InterventionKind.AddBiomass,
      radiusLU: 16,
      strength: 1500,
      falloff: BrushFalloff.Hard,
      samplesXLU: [x],
      samplesYLU: [y],
    },
    {
      kind: InterventionKind.RemoveBiomass,
      radiusLU: 16,
      strength: 1500,
      falloff: BrushFalloff.Linear,
      samplesXLU: [x],
      samplesYLU: [y - 16],
    },
    { kind: InterventionKind.Meteor, centerXLU: x, centerYLU: y, radiusLU: 32 },
  ];
}

describe("command determinism", () => {
  it("the same command stream produces the same state hash, tick for tick", () => {
    const a = smallWorld();
    const b = smallWorld();

    const schedule: Array<{ atTick: number; input: CommandInput }> = everyKind(a).map(
      (input, i) => ({ atTick: 10 + i * 20, input }),
    );

    for (const engine of [a, b]) {
      for (const entry of schedule) {
        const result = engine.queueCommand({ ...entry.input, targetTick: entry.atTick });
        expect(result.accepted).toBe(true);
      }
    }

    for (let tick = 0; tick < 240; tick += 1) {
      a.step();
      b.step();
      if (tick % 40 === 0 || tick === 239) {
        expect(b.computeStateHash()).toBe(a.computeStateHash());
      }
    }
    // Every command was applied exactly once and left the log applied.
    expect(a.commands.cursor).toBe(schedule.length);
    expect(a.commands.pendingCount).toBe(0);
  });

  it("a world with an empty command log runs exactly like one whose machinery was never touched", () => {
    // The no-command baseline: phase 0 with nothing queued must be a no-op.
    // Two engines, one of which exercises the queue with a REJECTED command
    // (rejections must not perturb authoritative state).
    const a = smallWorld();
    const b = smallWorld();
    const rejected = b.queueCommand({
      kind: InterventionKind.SetGlobalTemperature,
      offsetCentiC: 999_999,
    });
    expect(rejected.accepted).toBe(false);
    a.stepMany(120);
    b.stepMany(120);
    expect(b.computeStateHash()).toBe(a.computeStateHash());
  });

  it("commands accepted in one order and applied across ticks keep (tick, sequence) order", () => {
    const engine = smallWorld();
    // Accept a LATER-tick command first; the earlier-tick one must still apply
    // first, and both must be recorded in application order.
    const late = engine.queueCommand({
      kind: InterventionKind.SetGlobalTemperature,
      offsetCentiC: 400,
      targetTick: 30,
    });
    const early = engine.queueCommand({
      kind: InterventionKind.SetGlobalTemperature,
      offsetCentiC: -400,
      targetTick: 10,
    });
    expect(late.accepted && early.accepted).toBe(true);

    engine.stepMany(11);
    expect(engine.environment.globalTemperatureOffsetCentiC).toBe(-400);
    engine.stepMany(20);
    expect(engine.environment.globalTemperatureOffsetCentiC).toBe(400);

    // The log lists application order; identity remembers acceptance order.
    expect(engine.commands.at(0).tick).toBe(10);
    expect(engine.commands.at(1).tick).toBe(30);
    expect(engine.commands.at(0).sequence).toBeGreaterThan(engine.commands.at(1).sequence);
  });

  it("rejects targeting the past deterministically and without side effects", () => {
    const engine = smallWorld();
    engine.stepMany(50);
    const before = engine.computeStateHash();
    const result = engine.queueCommand({
      kind: InterventionKind.SetGlobalTemperature,
      offsetCentiC: 100,
      targetTick: 49,
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe(CommandRejectReason.PastTick);
    }
    expect(engine.commands.length).toBe(0);
    expect(engine.computeStateHash()).toBe(before);
  });
});

describe("commands across snapshots", () => {
  it("a snapshot carries the cursor: applied commands never re-apply, pending ones apply once", () => {
    const engine = smallWorld();
    const { x, y } = founderCentreLU(engine);

    // One command already applied, one pending for a future tick.
    engine.queueCommand({
      kind: InterventionKind.SetGlobalTemperature,
      offsetCentiC: 300,
      targetTick: 5,
    });
    engine.queueCommand({
      kind: InterventionKind.AddBiomass,
      radiusLU: 16,
      strength: 1000,
      falloff: BrushFalloff.Hard,
      samplesXLU: [x],
      samplesYLU: [y],
      targetTick: 40,
    });
    engine.stepMany(20);
    expect(engine.environment.globalTemperatureOffsetCentiC).toBe(300);
    expect(engine.commands.cursor).toBe(1);
    expect(engine.commands.pendingCount).toBe(1);

    const snapshot = engine.serialize();
    const restored = SimulationEngine.fromSnapshot(snapshot);
    expect(restored.computeStateHash()).toBe(engine.computeStateHash());
    expect(restored.commands.cursor).toBe(1);
    expect(restored.commands.pendingCount).toBe(1);
    // The applied global offset survived the restore WITHOUT re-application:
    // offsets are additive only through brushes; the global one is absolute,
    // so re-application would be invisible there — check biomass instead.
    // Continue both worlds through the pending command and beyond.
    engine.stepMany(40);
    restored.stepMany(40);
    expect(restored.computeStateHash()).toBe(engine.computeStateHash());
    expect(restored.commands.pendingCount).toBe(0);
  });

  it("a command applied before the save is not applied again on restore (value-level proof)", () => {
    const engine = smallWorld();
    const { x, y } = founderCentreLU(engine);
    const cell = engine.environment.cellIndexFromPosition(x * 256, y * 256);

    engine.queueCommand({
      kind: InterventionKind.PaintFertility,
      radiusLU: 16,
      strength: 300,
      falloff: BrushFalloff.Hard,
      samplesXLU: [x],
      samplesYLU: [y],
      targetTick: 2,
    });
    engine.stepMany(3);
    const fertilityAfterApply = engine.environment.fertilityQ[cell] as number;

    const restored = SimulationEngine.fromSnapshot(engine.serialize());
    // Fertility is additive: a double application would read +300 higher.
    expect(restored.environment.fertilityQ[cell]).toBe(fertilityAfterApply);
    restored.stepMany(5);
    expect(restored.environment.fertilityQ[cell]).toBe(fertilityAfterApply);
  });

  it("rejects a snapshot whose pending commands are already in the past", () => {
    const engine = smallWorld();
    engine.queueCommand({
      kind: InterventionKind.SetGlobalTemperature,
      offsetCentiC: 100,
      targetTick: 10,
    });
    engine.stepMany(5);
    const snapshot = engine.serialize();
    // Corrupt: claim the world is already past the pending command's tick.
    snapshot.tick = 50;
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrow(/pending but targets tick/);
  });

  it("rejects a snapshot that claims a future command was already applied", () => {
    const engine = smallWorld();
    engine.queueCommand({
      kind: InterventionKind.SetGlobalTemperature,
      offsetCentiC: 100,
      targetTick: 3,
    });
    engine.stepMany(10);
    const snapshot = engine.serialize();
    snapshot.tick = 2; // The log says the tick-3 command was applied; impossible at tick 2.
    expect(() => SimulationEngine.fromSnapshot(snapshot)).toThrow(/recorded as applied/);
  });
});

describe("command replay", () => {
  it("replaying the recorded log into a fresh engine reproduces the session exactly", () => {
    // The live session: commands issued at "whenever the player clicked".
    const live = smallWorld();
    const inputs = everyKind(live);
    live.stepMany(7);
    expect(live.queueCommand(inputs[0]!).accepted).toBe(true); // lands at tick 7
    live.stepMany(13);
    expect(live.queueCommand(inputs[1]!).accepted).toBe(true); // tick 20
    expect(live.queueCommand(inputs[8]!).accepted).toBe(true); // tick 20, later sequence
    live.stepMany(40);
    expect(live.queueCommand(inputs[6]!).accepted).toBe(true); // tick 60
    live.stepMany(40); // tick 100
    const finalHash = live.computeStateHash();
    const finalEvents = live.events.capture();

    // The replay: a fresh engine fed the RECORDED canonical commands (docs/06
    // §24 — same seed, same config, the log's own ticks), then run headless.
    const replay = smallWorld();
    for (const recorded of live.commands.list()) {
      const input: CommandInput =
        recorded.kind === InterventionKind.SetGlobalTemperature
          ? {
              kind: recorded.kind,
              offsetCentiC: recorded.offsetCentiC,
              targetTick: recorded.tick,
            }
          : recorded.kind === InterventionKind.Meteor
            ? {
                kind: recorded.kind,
                centerXLU: recorded.centerXLU,
                centerYLU: recorded.centerYLU,
                radiusLU: recorded.radiusLU,
                targetTick: recorded.tick,
              }
            : {
                kind: recorded.kind,
                radiusLU: recorded.radiusLU,
                strength: recorded.strength,
                falloff: recorded.falloff,
                samplesXLU: [...recorded.samplesXLU],
                samplesYLU: [...recorded.samplesYLU],
                targetTick: recorded.tick,
              };
      expect(replay.queueCommand(input).accepted).toBe(true);
    }
    replay.stepMany(100);

    expect(replay.computeStateHash()).toBe(finalHash);
    expect(replay.events.capture()).toEqual(finalEvents);
    expect(replay.commands.capture()).toEqual(live.commands.capture());
  });
});

describe("interventions in world history", () => {
  it("every applied command appears on the timeline as one PlayerIntervention event", () => {
    const engine = smallWorld();
    const inputs = everyKind(engine);
    for (const input of inputs) {
      expect(engine.queueCommand(input).accepted).toBe(true);
    }
    engine.stepMany(1);

    const events = engine.events.capture().events;
    const interventions = events.filter((e) => e.type === WorldEventType.PlayerIntervention);
    expect(interventions).toHaveLength(inputs.length);
    // Payload position 0 is the kind; position 1 the command id (stable
    // cross-reference into the immutable log).
    expect(interventions.map((e) => e.payload[0])).toEqual(inputs.map((input) => input.kind));
    const commandIds = interventions.map((e) => e.payload[1]);
    expect(commandIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Brushes and the meteor carry a region for the timeline map; the global
    // offset has none.
    expect(interventions[0]!.regionRadiusPos).toBe(-1);
    for (const event of interventions.slice(1)) {
      expect(event.regionRadiusPos).toBeGreaterThan(0);
    }
  });
});

describe("recompute parity", () => {
  it("recomputing a pristine generated world changes nothing", () => {
    const engine = smallWorld();
    const before = engine.computeStateHash();
    recomputeDerivedRegion(engine.environment, engine.config, 0, 0, SMALL_GRID - 1, SMALL_GRID - 1);
    expect(engine.computeStateHash()).toBe(before);
  });
});
