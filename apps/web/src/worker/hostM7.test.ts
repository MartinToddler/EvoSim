import { describe, expect, it } from "vitest";
import { viewTerrainSnapshot, type EntityDetailsPayload, type TelemetryDto } from "@eon/protocol";
import { SimulationHost } from "./SimulationHost";
import { TEST_SEED, TestRuntime, createTestConfig, message } from "./hostTestSupport";

/**
 * Milestone 7 host payload extensions: the display metadata in WORLD_READY,
 * the seven-plane terrain snapshot, telemetry trait means, and the inspector's
 * cost/brain fields — everything the observation UI consumes end to end.
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

describe("Milestone 7 host payloads", () => {
  it("WORLD_READY carries display labels, legend ranges and all seven planes", () => {
    const { runtime } = createReadyHost();
    const ready = runtime.last("WORLD_READY");
    expect(ready).toBeDefined();
    if (ready === undefined) {
      return;
    }

    const display = ready.payload.world.display;
    expect(display.brainInputLabels).toHaveLength(20);
    expect(display.brainIntentLabels).toEqual(["throttle", "turn", "eat", "attack", "reproduce"]);
    expect(display.deathCauseLabels.length).toBeGreaterThanOrEqual(8);
    expect(display.temperatureDisplayMinC).toBeLessThan(display.temperatureDisplayMaxC);
    expect(display.capacityDisplayReference).toBeGreaterThan(0);

    const terrain = viewTerrainSnapshot(ready.payload.terrain);
    expect(terrain.gridSize).toBe(64);
    // The layer planes hold real, varied data — not zero fill.
    for (const plane of [terrain.temperature, terrain.moisture, terrain.fertility]) {
      const values = new Set(plane);
      expect(values.size).toBeGreaterThan(1);
    }
    // Somewhere there is land with capacity; water cells keep capacity 0.
    expect(Math.max(...terrain.capacity)).toBeGreaterThan(0);
  });

  it("telemetry streams trait means and organism biomass for the charts", () => {
    const { runtime, host } = createReadyHost();
    host.handleMessage(message("SET_RUN_STATE", { speed: "x1" }));
    runtime.advance(1000);

    const telemetry = runtime.last("TELEMETRY")?.payload as TelemetryDto;
    expect(telemetry.population).toBeGreaterThan(0);
    expect(telemetry.organismMass).toBeGreaterThan(0);
    expect(telemetry.meanEnergyFraction).toBeGreaterThan(0);
    expect(telemetry.meanEnergyFraction).toBeLessThanOrEqual(1);
    expect(telemetry.traitMeans.adultRadiusLU).toBeGreaterThan(0);
    expect(telemetry.traitMeans.visionRangeLU).toBeGreaterThan(0);
    expect(telemetry.traitMeans.diet).toBeGreaterThanOrEqual(-1);
    expect(telemetry.traitMeans.diet).toBeLessThanOrEqual(1);
  });

  it("entity details answer with costs and the last tick's brain view", () => {
    const { runtime, host } = createReadyHost();
    host.handleMessage(message("SET_RUN_STATE", { speed: "x1" }));
    runtime.advance(500);
    host.handleMessage(message("SET_RUN_STATE", { speed: "paused" }));

    // Founders receive the lowest entity IDs; ID 1 exists on this fixture.
    host.handleMessage(message("QUERY_ENTITY", { entityId: 1 }, 77));
    const answer = runtime.last("ENTITY_DETAILS");
    expect(answer?.requestId).toBe(77);
    const payload = answer?.payload as EntityDetailsPayload;
    expect(payload.details).not.toBeNull();
    if (payload.details === null) {
      return;
    }
    expect(payload.details.brainInputs).toHaveLength(20);
    expect(payload.details.brainInputs[0]).toBe(1); // the constant bias input
    expect(payload.details.brainIntents).toHaveLength(5);
    expect(payload.details.costBasalPerTick).toBeGreaterThan(0);
    expect(payload.details.costMovementPerTick).toBeGreaterThanOrEqual(0);
    expect(payload.details.thermalStress).toBeGreaterThanOrEqual(0);
    expect(payload.details.thermalStress).toBeLessThanOrEqual(1);
  });
});
