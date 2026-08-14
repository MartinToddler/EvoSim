import { describe, expect, it } from "vitest";
import { SimulationEngine, InterventionKind, BrushFalloff } from "@eon/engine";
import type { CommandResultPayload, StateHashPayload, TelemetryDto } from "@eon/protocol";
import { SimulationHost } from "./SimulationHost";
import { TEST_SEED, TestRuntime, createTestConfig, message } from "./hostTestSupport";

/**
 * Milestone 9 host extensions, end to end through the message port: the
 * QUEUE_COMMAND → COMMAND_RESULT pair, terrain re-shipping after an applied
 * command, pending-command telemetry, and Worker-vs-headless determinism WITH
 * a command stream.
 */

function createReadyHost(): { runtime: TestRuntime; host: SimulationHost } {
  const runtime = new TestRuntime();
  const host = new SimulationHost({
    clock: runtime.clock,
    scheduler: runtime.scheduler,
    port: runtime.port,
  });
  host.handleMessage(
    message("INIT_NEW_WORLD", {
      seed: TEST_SEED,
      config: createTestConfig(),
      hostRuntime: null,
      speed: "paused",
    }),
  );
  return { runtime, host };
}

/** The world's founder centre in whole LU — guaranteed land for brushes. */
function founderCentre(runtime: TestRuntime): { x: number; y: number } {
  const ready = runtime.last("WORLD_READY");
  if (ready === undefined) {
    throw new Error("world not ready");
  }
  return {
    x: Math.round(ready.payload.world.founderCentreXLU),
    y: Math.round(ready.payload.world.founderCentreYLU),
  };
}

function lastCommandResult(runtime: TestRuntime): CommandResultPayload {
  const result = runtime.last("COMMAND_RESULT");
  if (result === undefined) {
    throw new Error("no COMMAND_RESULT posted");
  }
  return result.payload;
}

describe("Milestone 9 host commands", () => {
  it("WORLD_READY display carries intervention labels and config bounds", () => {
    const { runtime } = createReadyHost();
    const display = runtime.last("WORLD_READY")?.payload.world.display;
    expect(display?.interventionKindLabels).toContain("meteor");
    expect(display?.interventionKindLabels).toHaveLength(9);
    expect(display?.interventions.brushSampleSpacingLU).toBeGreaterThan(0);
    expect(display?.interventions.maxBrushRadiusLU).toBeGreaterThanOrEqual(
      display?.interventions.minBrushRadiusLU ?? Number.POSITIVE_INFINITY,
    );
  });

  it("QUEUE_COMMAND answers with the stamped identity and the command applies on the next tick", () => {
    const { runtime, host } = createReadyHost();
    const centre = founderCentre(runtime);
    runtime.clearPosted();

    host.handleMessage(
      message(
        "QUEUE_COMMAND",
        {
          command: {
            kind: "addBiomass",
            radiusLU: 16,
            strength: 500,
            falloff: "hard",
            samplesXLU: [centre.x],
            samplesYLU: [centre.y],
          },
        },
        41,
      ),
    );

    const result = lastCommandResult(runtime);
    expect(result.result.accepted).toBe(true);
    if (result.result.accepted) {
      expect(result.result.commandId).toBe(1);
      expect(result.result.tick).toBe(0);
      expect(result.result.sequence).toBe(1);
      expect(result.result.kind).toBe("addBiomass");
    }
    // Paused: accepted but not applied — telemetry reports it pending.
    host.handleMessage(message("SET_RUN_STATE", { speed: "paused" }));
    const pending = runtime.last("TELEMETRY")?.payload as TelemetryDto;
    expect(pending.pendingCommandCount).toBe(1);

    // Resume; the command applies at the next executed tick. Pausing again
    // forces a fresh telemetry frame, so the read is not at the mercy of the
    // 2 Hz cadence.
    host.handleMessage(message("SET_RUN_STATE", { speed: "x1" }));
    runtime.advance(120);
    expect(host.tick).toBeGreaterThan(0);
    host.handleMessage(message("SET_RUN_STATE", { speed: "paused" }));
    const after = runtime.last("TELEMETRY")?.payload as TelemetryDto;
    expect(after.pendingCommandCount).toBe(0);
  });

  it("an applied environment command re-ships the terrain exactly once", () => {
    const { runtime, host } = createReadyHost();
    const centre = founderCentre(runtime);
    runtime.clearPosted();

    host.handleMessage(
      message(
        "QUEUE_COMMAND",
        {
          command: {
            kind: "paintMoisture",
            radiusLU: 32,
            strength: 300,
            falloff: "linear",
            samplesXLU: [centre.x],
            samplesYLU: [centre.y],
          },
        },
        42,
      ),
    );
    expect(runtime.all("TERRAIN_SNAPSHOT")).toHaveLength(0);

    host.handleMessage(message("SET_RUN_STATE", { speed: "x1" }));
    runtime.advance(300);
    host.handleMessage(message("SET_RUN_STATE", { speed: "paused" }));

    // One command applied -> exactly one terrain refresh, carrying real bytes.
    const refreshes = runtime.all("TERRAIN_SNAPSHOT");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.payload.buffer.byteLength).toBeGreaterThan(0);
    expect(refreshes[0]!.payload.tick).toBeGreaterThanOrEqual(1);
  });

  it("a rejected command answers deterministically and perturbs nothing", () => {
    const { runtime, host } = createReadyHost();
    runtime.clearPosted();
    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: null }, 7));
    const before = (runtime.last("STATE_HASH")?.payload as StateHashPayload).hash;

    host.handleMessage(
      message(
        "QUEUE_COMMAND",
        { command: { kind: "setGlobalTemperature", offsetCentiC: 999_999 } },
        43,
      ),
    );
    const result = lastCommandResult(runtime);
    expect(result.result.accepted).toBe(false);
    if (!result.result.accepted) {
      expect(result.result.reason).toBe("outOfBounds");
      expect(result.result.detail).toContain("exceeds");
    }

    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: null }, 8));
    expect((runtime.last("STATE_HASH")?.payload as StateHashPayload).hash).toBe(before);
  });

  it("a world driven through the Worker with commands matches the headless engine", () => {
    const { runtime, host } = createReadyHost();
    const centre = founderCentre(runtime);

    // Worker path: run to tick 30, queue two commands for explicit ticks, run on.
    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: 30 }, 10));
    host.handleMessage(
      message(
        "QUEUE_COMMAND",
        {
          command: {
            kind: "lowerTerrain",
            radiusLU: 16,
            strength: 200,
            falloff: "hard",
            samplesXLU: [centre.x],
            samplesYLU: [centre.y],
            targetTick: 40,
          },
        },
        11,
      ),
    );
    host.handleMessage(
      message(
        "QUEUE_COMMAND",
        {
          command: { kind: "meteor", centerXLU: centre.x, centerYLU: centre.y, radiusLU: 32 },
        },
        12,
      ),
    );
    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: 90 }, 13));
    const workerHash = (runtime.last("STATE_HASH")?.payload as StateHashPayload).hash;

    // Headless path: the same seed, config and canonical command stream.
    const engine = new SimulationEngine({ seed: TEST_SEED, config: createTestConfig() });
    engine.stepMany(30);
    expect(
      engine.queueCommand({
        kind: InterventionKind.LowerTerrain,
        radiusLU: 16,
        strength: 200,
        falloff: BrushFalloff.Hard,
        samplesXLU: [centre.x],
        samplesYLU: [centre.y],
        targetTick: 40,
      }).accepted,
    ).toBe(true);
    expect(
      engine.queueCommand({
        kind: InterventionKind.Meteor,
        centerXLU: centre.x,
        centerYLU: centre.y,
        radiusLU: 32,
      }).accepted,
    ).toBe(true);
    engine.stepMany(60);
    expect(engine.computeStateHash()).toBe(workerHash);

    // The intervention events are on the timeline (task J08).
    runtime.clearPosted();
    host.handleMessage(message("REQUEST_HISTORY_RANGE", { sinceEventId: 0 }, 14));
    const history = runtime.last("HISTORY_EVENTS");
    const interventionEvents = history?.payload.history.events.filter((event) => event.type === 9);
    expect(interventionEvents?.length).toBe(2);
  });
});
