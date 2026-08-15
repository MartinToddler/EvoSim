import { describe, expect, it } from "vitest";
import type {
  HistoryEventsPayload,
  SpeciesDetailsPayload,
  TelemetryDto,
  TreeSnapshotPayload,
} from "@eon/protocol";
import { SimulationHost } from "./SimulationHost";
import { TEST_SEED, TestRuntime, createTestConfig, message } from "./hostTestSupport";

/**
 * Milestone 8 host extensions, end to end through the message port: species
 * telemetry, the QUERY_SPECIES / REQUEST_TREE / REQUEST_HISTORY_RANGE
 * request/response pairs, and the display label arrays the UI captions them
 * with.
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

describe("Milestone 8 host payloads", () => {
  it("WORLD_READY display carries the event, severity, end-reason and trait labels", () => {
    const { runtime } = createReadyHost();
    const ready = runtime.last("WORLD_READY");
    expect(ready).toBeDefined();
    if (ready === undefined) {
      return;
    }
    const display = ready.payload.world.display;
    expect(display.eventTypeLabels).toContain("speciesSplit");
    expect(display.eventTypeLabels).toContain("massExtinction");
    expect(display.eventSeverityLabels).toEqual(["info", "notable", "major"]);
    expect(display.speciesEndReasonLabels).toEqual(["active", "split", "extinct"]);
    expect(display.traitDimensionLabels).toHaveLength(15);
  });

  it("telemetry carries live species counts and the latest event id", () => {
    const { runtime, host } = createReadyHost();
    host.handleMessage(message("SET_RUN_STATE", { speed: "x1" }));
    runtime.advance(1000);

    const telemetry = runtime.last("TELEMETRY")?.payload as TelemetryDto;
    expect(telemetry.activeSpeciesCount).toBe(1);
    expect(telemetry.totalSpeciesCount).toBe(1);
    expect(telemetry.extinctSpeciesCount).toBe(0);
    // WorldCreated exists from tick 0, so the latest event ID is at least 1.
    expect(telemetry.latestEventId).toBeGreaterThanOrEqual(1);
  });

  it("QUERY_SPECIES answers with correlated inspector details", () => {
    const { runtime, host } = createReadyHost();
    host.handleMessage(message("QUERY_SPECIES", { speciesId: 1 }, 41));

    const answer = runtime.last("SPECIES_DETAILS");
    expect(answer?.requestId).toBe(41);
    const payload = answer?.payload as SpeciesDetailsPayload;
    expect(payload.speciesId).toBe(1);
    expect(payload.details).not.toBeNull();
    expect(payload.details?.population).toBeGreaterThan(0);
    expect(payload.details?.parentSpeciesId).toBe(0);
    expect(payload.details?.centroidTraits).toHaveLength(15);
    // Normalized to unit fractions at the host boundary.
    for (const value of payload.details?.centroidTraits ?? []) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(payload.details?.stabilityIntervalsRequired).toBeGreaterThan(0);
  });

  it("QUERY_SPECIES for an unissued ID answers null instead of erroring", () => {
    const { runtime, host } = createReadyHost();
    host.handleMessage(message("QUERY_SPECIES", { speciesId: 999 }, 42));
    const payload = runtime.last("SPECIES_DETAILS")?.payload as SpeciesDetailsPayload;
    expect(payload.details).toBeNull();
  });

  it("REQUEST_TREE answers the whole registry", () => {
    const { runtime, host } = createReadyHost();
    host.handleMessage(message("REQUEST_TREE", {}, 43));
    const answer = runtime.last("TREE_SNAPSHOT");
    expect(answer?.requestId).toBe(43);
    const payload = answer?.payload as TreeSnapshotPayload;
    expect(payload.tree.species).toHaveLength(1);
    expect(payload.tree.species[0]?.id).toBe(1);
    expect(payload.tree.species[0]?.endReason).toBe(0);
  });

  it("REQUEST_HISTORY_RANGE pages by event id and includes the world series", () => {
    const { runtime, host } = createReadyHost();
    host.handleMessage(message("SET_RUN_STATE", { speed: "x1" }));
    runtime.advance(6000); // > 100 ticks: at least one statistics sample lands

    host.handleMessage(message("REQUEST_HISTORY_RANGE", { sinceEventId: 0 }, 44));
    const all = runtime.last("HISTORY_EVENTS")?.payload as HistoryEventsPayload;
    // WorldCreated is retained and first.
    expect(all.history.events.length).toBeGreaterThanOrEqual(1);
    expect(all.history.events[0]?.id).toBe(1);
    expect(all.history.events[0]?.type).toBe(0);
    expect(all.history.events[0]?.region).not.toBeNull();
    expect(all.history.worldSeries.ticks.length).toBeGreaterThan(0);
    expect(all.history.worldSeries.population.length).toBe(all.history.worldSeries.ticks.length);

    const newest = all.history.events.at(-1)?.id as number;
    host.handleMessage(message("REQUEST_HISTORY_RANGE", { sinceEventId: newest }, 45));
    const none = runtime.last("HISTORY_EVENTS")?.payload as HistoryEventsPayload;
    expect(none.history.events).toHaveLength(0);
  });

  it("species queries do not perturb the simulation", () => {
    const { host } = createReadyHost();
    const before = host.stateHash();
    host.handleMessage(message("QUERY_SPECIES", { speciesId: 1 }, 46));
    host.handleMessage(message("REQUEST_TREE", {}, 47));
    host.handleMessage(message("REQUEST_HISTORY_RANGE", { sinceEventId: 0 }, 48));
    expect(host.stateHash()).toBe(before);
  });
});
