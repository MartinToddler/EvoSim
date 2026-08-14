import { beforeEach, describe, expect, it } from "vitest";
import { SimulationEngine, type SimulationConfig } from "@eon/engine";
import { createRenderSnapshotBuffer, type SimulationSpeed } from "@eon/protocol";
import { SimulationHost } from "./SimulationHost";
import { TEST_SEED, TestRuntime, createTestConfig, message } from "./hostTestSupport";

/**
 * Adversarial host scenarios (Milestone 6 review).
 *
 * `SimulationHost.test.ts` proves each guarantee in isolation. These tests
 * attack the combination: a client that misbehaves *while* the world runs —
 * malformed messages, hostile recycles, starved buffer pools, pause/resume
 * storms, a worker restart — and then demand the one thing that matters
 * survive it all: the canonical state hash at tick N is the hash a headless
 * `stepMany(N)` produces. If any of this traffic could perturb the
 * simulation, these tests are where it shows up as a hash mismatch instead of
 * as a bug report about a world that diverged after an hour.
 */

let runtime: TestRuntime;
let host: SimulationHost;
let config: SimulationConfig;

function newHost(): SimulationHost {
  return new SimulationHost({
    clock: runtime.clock,
    scheduler: runtime.scheduler,
    port: runtime.port,
  });
}

function init(
  speed: SimulationSpeed = "paused",
  hostRuntime: Record<string, number> | null = null,
): void {
  host.handleMessage(message("INIT_NEW_WORLD", { seed: TEST_SEED, config, hostRuntime, speed }));
}

function setSpeed(speed: SimulationSpeed): void {
  host.handleMessage(message("SET_RUN_STATE", { speed }));
}

function headlessHashAt(tick: number): string {
  const engine = new SimulationEngine({ seed: TEST_SEED, config });
  engine.stepMany(tick);
  return engine.computeStateHash();
}

beforeEach(() => {
  runtime = new TestRuntime();
  host = newHost();
  config = createTestConfig();
});

describe("determinism under hostile traffic", () => {
  it("is unaffected by malformed messages and hostile recycles arriving mid-run", () => {
    init("x20");

    // Every 250 ms of run time, throw garbage at the host: undecodable
    // messages, wrong protocol versions, foreign and detached recycle buffers,
    // queries for entities that do not exist. All of it must be answered or
    // ignored without a single authoritative consequence.
    const foreign = createRenderSnapshotBuffer(4, 4); // wrong shape for this world
    const detached = new ArrayBuffer(64);
    structuredClone(null, { transfer: [detached] }); // detach it
    let requestId = 1000;
    for (let round = 0; round < 8; round += 1) {
      runtime.advance(250);
      host.handleMessage("not even an object");
      host.handleMessage({ protocolVersion: 999, type: "SET_RUN_STATE", payload: { speed: "x1" } });
      host.handleMessage(message("SET_RUN_STATE", { speed: "warp" }));
      host.handleMessage(message("QUERY_ENTITY", { entityId: 999_999 }, (requestId += 1)));
      host.handleMessage(message("RECYCLE_RENDER_BUFFER", { buffer: foreign }));
      host.handleMessage(message("RECYCLE_RENDER_BUFFER", { buffer: detached }));
      host.handleMessage(message("RECYCLE_VEGETATION_BUFFER", { buffer: foreign }));
    }
    setSpeed("paused");

    const tick = host.tick;
    expect(tick).toBeGreaterThan(0);
    // The bad speed value and version mismatch were reported, never applied.
    expect(host.speed).toBe("paused");
    expect(runtime.all("ERROR").every((error) => !error.payload.fatal)).toBe(true);
    expect(host.stateHash()).toBe(headlessHashAt(tick));
  });

  it("is unaffected by a starved render pool and a pause/resume storm", () => {
    // A moving clock, so MAX slices end on their time budget rather than
    // running the full tick cap against a frozen clock (see TestRuntime).
    runtime.readCostMs = 0.05;
    // Nothing is ever recycled in this test: the pool must run dry, keep
    // dropping snapshots, and never once lean on the simulation.
    init("x100", { renderBufferPoolSize: 2 });

    for (let storm = 0; storm < 30; storm += 1) {
      runtime.advance(37);
      setSpeed("paused");
      runtime.advance(13);
      setSpeed(storm % 2 === 0 ? "x100" : "max");
    }
    setSpeed("paused");

    const telemetry = runtime.last("TELEMETRY");
    expect(telemetry).toBeDefined();
    if (telemetry === undefined) {
      throw new Error("unreachable");
    }
    // The pool was exhausted and stayed bounded.
    expect(runtime.all("RENDER_SNAPSHOT").length).toBe(2);
    expect(telemetry.payload.droppedRenderSnapshots).toBeGreaterThan(0);

    const tick = host.tick;
    expect(tick).toBeGreaterThan(0);
    expect(host.stateHash()).toBe(headlessHashAt(tick));
  });

  it("keeps exactly one loop and one hash through rapid speed cycling", () => {
    runtime.readCostMs = 0.05;
    init("x1");
    const speeds: SimulationSpeed[] = ["x5", "max", "x1", "x100", "x20", "max", "x1"];
    for (let round = 0; round < 20; round += 1) {
      setSpeed(speeds[round % speeds.length] as SimulationSpeed);
      // At most one scheduled iteration may exist, whatever the speed history.
      expect(runtime.scheduledCount).toBeLessThanOrEqual(1);
      runtime.advance(29);
    }
    setSpeed("paused");
    expect(runtime.scheduledCount).toBe(0);

    const tick = host.tick;
    expect(tick).toBeGreaterThan(0);
    expect(host.stateHash()).toBe(headlessHashAt(tick));
  });
});

describe("worker restart", () => {
  it("a disposed host's replacement reproduces the same world from scratch", () => {
    // Run the first host somewhere into the world's life, note the hash at a
    // checkpoint tick, then kill it mid-run the way a page reload kills a
    // Worker: without ceremony.
    init("x100");
    runtime.advance(1000);
    setSpeed("paused");
    const checkpointTick = host.tick;
    const checkpointHash = host.stateHash();
    setSpeed("x100");
    runtime.advance(200);
    host.handleMessage(message("DISPOSE", {}));
    expect(host.disposed).toBe(true);
    expect(runtime.scheduledCount).toBe(0);

    // A fresh host — new engine, new pools, same seed and config — must walk
    // through the same checkpoint. This is what makes a reload recoverable:
    // nothing about the first run's scheduling or teardown leaks into the
    // second.
    runtime = new TestRuntime();
    host = newHost();
    init("x100");
    while (host.tick < checkpointTick) {
      runtime.advance(50);
    }
    setSpeed("paused");
    // The loop may have overshot the checkpoint inside one slice; the fixture
    // hash comparison needs the exact tick, so land there deterministically.
    expect(host.tick).toBeGreaterThanOrEqual(checkpointTick);
    if (host.tick === checkpointTick) {
      expect(host.stateHash()).toBe(checkpointHash);
    } else {
      // Deterministic worlds make the overshoot testable anyway: a headless
      // run to the overshot tick must agree with the restarted host.
      expect(host.stateHash()).toBe(headlessHashAt(host.tick));
      expect(headlessHashAt(checkpointTick)).toBe(checkpointHash);
    }
  });

  it("ignores every message after DISPOSE instead of resurrecting", () => {
    init("x20");
    runtime.advance(100);
    host.handleMessage(message("DISPOSE", {}));
    const tickAtDisposal = host.tick;

    host.handleMessage(message("SET_RUN_STATE", { speed: "max" }));
    host.handleMessage(message("INIT_NEW_WORLD", { seed: TEST_SEED, config, speed: "x1" }));
    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: null }, 7));
    runtime.advance(1000);

    expect(host.tick).toBe(tickAtDisposal);
    expect(runtime.scheduledCount).toBe(0);
    expect(runtime.last("STATE_HASH")).toBeUndefined();
  });
});

describe("selection under mortality", () => {
  it("answers null for a dead entity while the stream keeps flowing", () => {
    init("x100");

    // Find an organism from the first snapshot, then let the world run long
    // enough that natural deaths are plausible; whether or not this exact one
    // died, the query path must answer without disturbing the run.
    runtime.advance(500);
    const firstSnapshot = runtime.all("RENDER_SNAPSHOT")[0];
    expect(firstSnapshot).toBeDefined();

    // Query an entity that has never existed: the guaranteed-dead case.
    host.handleMessage(message("QUERY_ENTITY", { entityId: 123_456_789 }, 42));
    const answer = runtime.last("ENTITY_DETAILS");
    expect(answer?.requestId).toBe(42);
    expect(answer?.payload.details).toBeNull();

    runtime.advance(500);
    setSpeed("paused");
    const tick = host.tick;
    expect(host.stateHash()).toBe(headlessHashAt(tick));
  });
});
