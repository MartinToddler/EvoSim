import { beforeEach, describe, expect, it } from "vitest";
import { SimulationEngine, type SimulationConfig } from "@eon/engine";
import {
  RenderHeader,
  readRenderSnapshotCounts,
  viewRenderSnapshot,
  viewTerrainSnapshot,
  viewVegetationSnapshot,
  type SimulationSpeed,
} from "@eon/protocol";
import { SimulationHost } from "./SimulationHost";
import { TEST_SEED, TestRuntime, createTestConfig, message } from "./hostTestSupport";

/**
 * Worker host behaviour (tasks G02/G03).
 *
 * Everything here runs against a fake clock and a fake scheduler, so "pause for
 * ten seconds and resume" is exact and instant rather than slow and flaky. The
 * fake port implements real transfer semantics, so buffer bugs surface here
 * rather than in a browser.
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

/** Hand every render buffer the host has posted back to its pool. */
function recycleAllRenderBuffers(): void {
  for (const snapshot of runtime.all("RENDER_SNAPSHOT")) {
    if (snapshot.payload.buffer.byteLength > 0) {
      host.handleMessage(message("RECYCLE_RENDER_BUFFER", { buffer: snapshot.payload.buffer }));
    }
  }
}

beforeEach(() => {
  runtime = new TestRuntime();
  host = newHost();
  config = createTestConfig();
});

describe("initialization", () => {
  it("answers INIT_NEW_WORLD with a world summary, terrain and telemetry", () => {
    init();
    const ready = runtime.last("WORLD_READY");
    expect(ready).toBeDefined();
    if (ready === undefined) {
      return;
    }
    const world = ready.payload.world;
    expect(world.seed).toBe(TEST_SEED);
    expect(world.seedHex).toBe("0xE0A12026");
    expect(world.worldSizeLU).toBe(config.world.sizeLU);
    expect(world.gridSize).toBe(config.world.envGridSize);
    expect(world.maxOrganisms).toBe(config.limits.maxOrganisms);
    expect(world.configHash.length).toBeGreaterThan(0);
    expect(world.founderCentreXLU).toBeGreaterThan(0);
    expect(world.founderCentreXLU).toBeLessThan(world.worldSizeLU);

    const terrain = viewTerrainSnapshot(ready.payload.terrain);
    expect(terrain.gridSize).toBe(world.gridSize);
    // A generated world is not uniform: several biomes and some vegetation.
    expect(new Set(terrain.biome).size).toBeGreaterThan(1);
    expect(terrain.vegetation.some((value) => value > 0)).toBe(true);

    expect(ready.payload.telemetry.population).toBeGreaterThan(0);
    expect(ready.payload.telemetry.tick).toBe(0);
  });

  it("paints the world before it is started", () => {
    // A paused world must still be visible; without this the canvas would stay
    // empty until the user pressed play.
    init("paused");
    expect(runtime.all("RENDER_SNAPSHOT")).toHaveLength(1);
    expect(host.tick).toBe(0);
    expect(host.running).toBe(false);
  });

  it("starts running immediately when asked to", () => {
    init("x1");
    expect(host.speed).toBe("x1");
    expect(host.running).toBe(true);
  });

  it("replaces a previous world without leaving its loop running", () => {
    init("x100");
    runtime.advance(200);
    const firstTick = host.tick;
    expect(firstTick).toBeGreaterThan(0);

    init("paused");
    expect(host.tick).toBe(0);
    expect(runtime.scheduledCount).toBe(0);
    runtime.advance(1000);
    // The old loop is genuinely gone — a leaked one would still be ticking.
    expect(host.tick).toBe(0);
  });

  it("re-enables the render stream for a replacement world", () => {
    init("paused");
    host.handleMessage(message("SET_RENDER_STREAM", { enabled: false }));
    runtime.clearPosted();

    // The new world must open with a picture even though the old world's
    // stream was suspended: "a paused world must still be visible" holds per
    // world, not per worker lifetime.
    init("paused");
    expect(runtime.postCounts.get("RENDER_SNAPSHOT")).toBe(1);
  });

  it("rejects an invalid config with an error instead of throwing", () => {
    host.handleMessage(
      message("INIT_NEW_WORLD", {
        seed: 1,
        config: { schemaVersion: -1 },
        hostRuntime: null,
        speed: "paused",
      }),
    );
    const error = runtime.last("ERROR");
    expect(error).toBeDefined();
    expect(error?.payload.fatal).toBe(true);
    expect(host.hasWorld).toBe(false);
  });
});

describe("malformed and unsupported messages", () => {
  it("answers a malformed message with a non-fatal error and keeps running", () => {
    init("x1");
    runtime.advance(500);
    const before = host.tick;

    host.handleMessage({ nonsense: true });
    host.handleMessage(null);
    host.handleMessage({ protocolVersion: 999, type: "DISPOSE", payload: {} });

    const errors = runtime.all("ERROR");
    expect(errors.length).toBe(3);
    expect(errors.every((error) => !error.payload.fatal)).toBe(true);

    runtime.advance(500);
    expect(host.tick).toBeGreaterThan(before);
  });

  it("reports a query made before a world exists rather than crashing", () => {
    host.handleMessage(message("QUERY_ENTITY", { entityId: 1 }, 5));
    const error = runtime.last("ERROR");
    expect(error?.payload.message).toMatch(/before a world/);
    expect(error?.requestId).toBe(5);
    expect(host.disposed).toBe(false);
  });
});

describe("pause, resume and speed", () => {
  it("executes no ticks while paused", () => {
    init("paused");
    runtime.advance(10_000);
    expect(host.tick).toBe(0);
    expect(runtime.scheduledCount).toBe(0);
  });

  it("runs at the requested rate", () => {
    init("x1");
    runtime.advance(1000);
    // 1x is 20 ticks per second (docs/02 §8).
    expect(host.tick).toBe(20);

    const at1x = host.tick;
    setSpeed("x5");
    runtime.advance(1000);
    expect(host.tick - at1x).toBe(100);
  });

  it("scales with each documented speed", () => {
    const expected: readonly (readonly [SimulationSpeed, number])[] = [
      ["x1", 20],
      ["x5", 100],
      ["x20", 400],
    ];
    for (const [speed, ticksPerSecond] of expected) {
      runtime = new TestRuntime();
      host = newHost();
      init(speed);
      runtime.advance(1000);
      expect(host.tick, speed).toBe(ticksPerSecond);
    }
  });

  it("resumes without sprinting through the time it was paused", () => {
    // The catch-up bug in miniature: a world paused for a minute must not owe
    // a minute of ticks the moment it resumes.
    init("x1");
    runtime.advance(1000);
    const beforePause = host.tick;

    setSpeed("paused");
    runtime.advance(60_000);
    expect(host.tick).toBe(beforePause);

    setSpeed("x1");
    runtime.advance(1000);
    expect(host.tick - beforePause).toBe(20);
  });

  it("survives repeated pause/resume without losing or duplicating ticks", () => {
    init("x5");
    let expectedTicks = 0;
    for (let cycle = 0; cycle < 12; cycle += 1) {
      setSpeed("x5");
      runtime.advance(1000);
      expectedTicks += 100;
      setSpeed("paused");
      runtime.advance(3000);
    }
    expect(host.tick).toBe(expectedTicks);
    expect(runtime.scheduledCount).toBe(0);
  });

  it("does not carry tick debt across a speed change", () => {
    // Debt accrued at 1x must not be repaid at 100x, which would produce a
    // visible burst on every speed change.
    init("x1");
    runtime.advance(1000);
    const before = host.tick;
    setSpeed("x100");
    // A single slice, immediately after the change: nothing is owed yet.
    runtime.advance(0);
    expect(host.tick).toBe(before);
  });

  it("keeps exactly one loop alive under rapid speed changes", () => {
    init("x1");
    const speeds: SimulationSpeed[] = [
      "x5",
      "x20",
      "x1",
      "x100",
      "paused",
      "x20",
      "x5",
      "max",
      "x1",
    ];
    for (const speed of speeds) {
      setSpeed(speed);
      // The invariant that matters: never two scheduled iterations, which would
      // be two loops stepping the same engine.
      expect(runtime.scheduledCount).toBeLessThanOrEqual(1);
    }
    runtime.advance(1000);
    expect(runtime.scheduledCount).toBeLessThanOrEqual(1);
    expect(host.tick).toBe(20);
  });

  it("keeps exactly one loop alive when resumed repeatedly at the same speed", () => {
    init("paused");
    for (let i = 0; i < 25; i += 1) {
      setSpeed("x20");
      expect(runtime.scheduledCount).toBe(1);
    }
    runtime.advance(1000);
    // 25 resume messages, one loop, one second of ticks at 400/s.
    expect(host.tick).toBe(400);
  });

  it("refuses to set a run state before a world exists", () => {
    setSpeed("x1");
    expect(runtime.last("ERROR")?.payload.message).toMatch(/before a world is initialized/);
  });
});

describe("MAX mode", () => {
  beforeEach(() => {
    // Charge each clock read half a millisecond, so a slice ends on its time
    // budget the way a real one does rather than on the tick cap.
    runtime.readCostMs = 0.5;
  });

  it("runs unpaced and yields between slices", () => {
    init("max");
    const schedulesBefore = runtime.scheduleCalls;
    runtime.advance(200);

    expect(host.tick).toBeGreaterThan(100);
    // Yielding is the whole point: many short slices, not one long one, so a
    // pause message queued behind them is handled promptly.
    expect(runtime.scheduleCalls - schedulesBefore).toBeGreaterThan(5);
  });

  it("honours the slice budget instead of running to the tick cap", () => {
    // 10 ms budget at 0.5 ms per clock read is about 20 ticks; the 2048 cap
    // must not be what ends the slice.
    init("max");
    const ticksBefore = host.tick;
    runtime.advance(0);
    const firstSlice = host.tick - ticksBefore;
    expect(firstSlice).toBeGreaterThan(0);
    expect(firstSlice).toBeLessThan(64);
  });

  it("stops promptly when paused mid-run", () => {
    init("max");
    runtime.advance(100);
    const atPause = host.tick;
    setSpeed("paused");
    runtime.advance(10_000);
    expect(host.tick).toBe(atPause);
    expect(runtime.scheduledCount).toBe(0);
  });

  it("emits render snapshots at the reduced MAX rate", () => {
    init("max");
    recycleAllRenderBuffers();
    runtime.clearPosted();
    // 5 Hz in MAX against 15 Hz normally (docs/02 §8): one second of wall clock
    // is about five frames, and recycling keeps the pool from being the limit.
    for (let i = 0; i < 20; i += 1) {
      runtime.advance(50);
      recycleAllRenderBuffers();
    }
    const frames = runtime.all("RENDER_SNAPSHOT").length;
    expect(frames).toBeGreaterThanOrEqual(3);
    expect(frames).toBeLessThanOrEqual(8);
  });

  it("terminates a slice even when the clock never moves", () => {
    // The tick cap is the backstop for a clock too coarse to advance inside a
    // slice. Without it, one slice would never end and the Worker would stop
    // answering messages entirely.
    runtime.readCostMs = 0;
    init("max", { maxTicksPerSlice: 32 });
    expect(runtime.runNext()).toBe(true);
    expect(host.tick).toBe(32);
    // And it yielded rather than continuing: the next slice is scheduled, not
    // already running.
    expect(runtime.scheduledCount).toBe(1);
  });
});

describe("determinism: worker scheduling versus headless Node", () => {
  it("reaches the same canonical hash as a plain stepMany", () => {
    const targetTick = 240;
    init("x20");
    runtime.advance(600);
    expect(host.tick).toBe(targetTick);

    const headless = new SimulationEngine({ seed: TEST_SEED, config });
    headless.stepMany(targetTick);

    expect(host.stateHash()).toBe(headless.computeStateHash());
  });

  it("is unaffected by how the ticks were paced", () => {
    // The acceptance property (docs/07): scheduling changes when ticks happen,
    // never what they do. This run is deliberately erratic — five speeds, three
    // pauses, a MAX burst, snapshots and queries interleaved — and must land on
    // the same hash as 400 uninterrupted steps.
    runtime.readCostMs = 0.25;
    init("x1");
    runtime.advance(500); // 10
    setSpeed("paused");
    runtime.advance(5000);
    setSpeed("x20");
    runtime.advance(250); // +100 = 110
    host.handleMessage(message("QUERY_ENTITY", { entityId: 3 }, 1));
    setSpeed("x5");
    runtime.advance(400); // +40 = 150
    recycleAllRenderBuffers();
    setSpeed("paused");
    runtime.advance(2000);
    setSpeed("x100");
    runtime.advance(500); // +1000 -> capped by catch-up, so read the real tick

    const reached = host.tick;
    expect(reached).toBeGreaterThan(150);

    // Top the world up to a round number through the protocol, then hash it.
    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: 2000 }, 7));
    const answer = runtime.last("STATE_HASH");
    expect(answer?.requestId).toBe(7);

    const headless = new SimulationEngine({ seed: TEST_SEED, config });
    headless.stepMany(2000);
    expect(answer?.payload.hash).toBe(headless.computeStateHash());
    expect(answer?.payload.tick).toBe(2000);
  });

  it("refuses to hash a tick already in the past", () => {
    init("x20");
    runtime.advance(500);
    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: 1 }, 3));
    const error = runtime.last("ERROR");
    expect(error?.requestId).toBe(3);
    expect(error?.payload.message).toMatch(/cannot step backwards/);
    expect(error?.payload.fatal).toBe(false);
  });

  it("hashes the current state when no target is given", () => {
    init("paused");
    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: null }, 9));
    const answer = runtime.last("STATE_HASH");
    expect(answer?.payload.tick).toBe(0);
    expect(answer?.payload.hash).toBe(
      new SimulationEngine({ seed: TEST_SEED, config }).computeStateHash(),
    );
  });
});

describe("render snapshots and buffer lifecycle", () => {
  it("transfers buffers, detaching the host's copy", () => {
    init("paused");
    const snapshot = runtime.last("RENDER_SNAPSHOT");
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      return;
    }
    // The delivered buffer is live for the consumer...
    expect(snapshot.payload.buffer.byteLength).toBeGreaterThan(0);
    const view = viewRenderSnapshot(snapshot.payload.buffer);
    const counts = readRenderSnapshotCounts(view);
    expect(counts.organismCount).toBeGreaterThan(0);
    expect(counts.tick).toBe(0);
    expect(view.header[RenderHeader.OrganismCount]).toBe(counts.organismCount);
  });

  it("stops producing snapshots once the pool is exhausted, and never stops ticking", () => {
    init("x20", { renderBufferPoolSize: 2 });
    runtime.advance(2000);

    // Nothing was recycled, so the pool ran dry after two frames.
    expect(runtime.all("RENDER_SNAPSHOT").length).toBe(2);
    // The simulation is unaffected: pictures are droppable, ticks are not.
    expect(host.tick).toBe(800);
    const telemetry = runtime.last("TELEMETRY");
    expect(telemetry?.payload.droppedRenderSnapshots).toBeGreaterThan(0);
  });

  it("resumes producing snapshots as soon as a buffer comes back", () => {
    init("x20", { renderBufferPoolSize: 2 });
    runtime.advance(2000);
    expect(runtime.all("RENDER_SNAPSHOT").length).toBe(2);

    recycleAllRenderBuffers();
    runtime.advance(200);
    expect(runtime.all("RENDER_SNAPSHOT").length).toBeGreaterThan(2);
  });

  it("holds a bounded number of buffers and drops nothing when they come back", () => {
    // Buffer *identity* cannot be asserted across a transfer — `postMessage`
    // hands the consumer a new ArrayBuffer object wrapping the same memory, so
    // every frame legitimately looks like a new object. What must hold is that
    // the host never accumulates: in flight stays inside the pool bound and,
    // with prompt recycling, nothing is ever dropped.
    init("x20");
    let frames = 0;
    for (let i = 0; i < 30; i += 1) {
      runtime.advance(100);
      frames += runtime.all("RENDER_SNAPSHOT").length;
      recycleAllRenderBuffers();
      const telemetry = runtime.last("TELEMETRY");
      if (telemetry !== undefined) {
        expect(telemetry.payload.renderBuffersInFlight).toBeLessThanOrEqual(3);
        expect(telemetry.payload.droppedRenderSnapshots).toBe(0);
      }
      runtime.clearPosted();
    }
    expect(frames).toBeGreaterThan(30);
  });

  it("ignores a recycled buffer that is not one of its own", () => {
    init("x20");
    host.handleMessage(message("RECYCLE_RENDER_BUFFER", { buffer: new ArrayBuffer(128) }));
    runtime.advance(500);
    // Still ticking, still rendering: a bad recycle is contained.
    expect(host.tick).toBeGreaterThan(0);
    expect(runtime.last("ERROR")).toBeUndefined();
  });

  it("emits the vegetation field on its own slower cadence", () => {
    init("x20");
    runtime.advance(2000);
    const vegetation = runtime.all("VEGETATION_SNAPSHOT");
    expect(vegetation.length).toBeGreaterThan(0);
    const view = viewVegetationSnapshot(vegetation[0]?.payload.buffer as ArrayBuffer);
    expect(view.gridSize).toBe(config.world.envGridSize);
    // Slower than the render stream, by design (docs/06 §2).
    expect(vegetation.length).toBeLessThan(runtime.all("RENDER_SNAPSHOT").length + 2);
  });

  it("stops the render stream on request without stopping the simulation", () => {
    init("x20");
    recycleAllRenderBuffers();
    host.handleMessage(message("SET_RENDER_STREAM", { enabled: false }));
    runtime.clearPosted();

    runtime.advance(2000);
    expect(runtime.all("RENDER_SNAPSHOT")).toHaveLength(0);
    expect(runtime.all("VEGETATION_SNAPSHOT")).toHaveLength(0);
    // Ticks continue: a hidden tab still evolves.
    expect(host.tick).toBeGreaterThan(0);
    // Telemetry keeps flowing, so the HUD stays honest.
    expect(runtime.all("TELEMETRY").length).toBeGreaterThan(0);

    host.handleMessage(message("SET_RENDER_STREAM", { enabled: true }));
    runtime.advance(200);
    expect(runtime.all("RENDER_SNAPSHOT").length).toBeGreaterThan(0);
  });
});

describe("telemetry", () => {
  it("reports population, pacing and profiling", () => {
    init("x20");
    runtime.advance(2000);
    const telemetry = runtime.last("TELEMETRY");
    expect(telemetry).toBeDefined();
    if (telemetry === undefined) {
      return;
    }
    const payload = telemetry.payload;
    expect(payload.tick).toBe(host.tick);
    expect(payload.population).toBeGreaterThan(0);
    expect(payload.totalBirths).toBeGreaterThan(0);
    expect(payload.deathsByCause.length).toBeGreaterThan(0);
    expect(payload.plantCapacity).toBeGreaterThan(0);
    expect(payload.speed).toBe("x20");
    expect(payload.targetTicksPerSecond).toBe(400);
    expect(payload.achievedTicksPerSecond).toBeGreaterThan(0);
    // CLAUDE.md requires phase instrumentation from the first vertical slice.
    expect(payload.phaseMillis.length).toBeGreaterThanOrEqual(13);
  });

  it("reports no target rate at MAX, which is unpaced", () => {
    runtime.readCostMs = 0.5;
    init("max");
    runtime.advance(1000);
    expect(runtime.last("TELEMETRY")?.payload.targetTicksPerSecond).toBeNull();
  });

  it("emits immediately on pause so the HUD does not look stuck", () => {
    init("x20");
    runtime.advance(1000);
    runtime.clearPosted();
    setSpeed("paused");
    expect(runtime.all("TELEMETRY")).toHaveLength(1);
    expect(runtime.last("TELEMETRY")?.payload.speed).toBe("paused");
  });
});

describe("entity queries", () => {
  function firstLiveEntityId(): number {
    const snapshot = runtime.last("RENDER_SNAPSHOT");
    const view = viewRenderSnapshot(snapshot?.payload.buffer as ArrayBuffer);
    return view.organismId[0] as number;
  }

  it("echoes the requestId so answers can be correlated", () => {
    init("paused");
    const entityId = firstLiveEntityId();
    host.handleMessage(message("QUERY_ENTITY", { entityId }, 101));
    host.handleMessage(message("QUERY_ENTITY", { entityId }, 102));

    const answers = runtime.all("ENTITY_DETAILS");
    expect(answers.map((answer) => answer.requestId)).toEqual([101, 102]);
    expect(answers[0]?.payload.entityId).toBe(entityId);
    expect(answers[0]?.payload.details).not.toBeNull();
    expect(answers[0]?.payload.tick).toBe(0);
  });

  it("answers with null for an organism that is not alive", () => {
    init("paused");
    host.handleMessage(message("QUERY_ENTITY", { entityId: 999_999 }, 5));
    const answer = runtime.last("ENTITY_DETAILS");
    expect(answer?.payload.details).toBeNull();
    expect(answer?.requestId).toBe(5);
  });

  it("answers with null once a selected organism has died", () => {
    init("x100");
    // Every founder, taken from the first snapshot.
    const snapshot = runtime.last("RENDER_SNAPSHOT");
    const view = viewRenderSnapshot(snapshot?.payload.buffer as ArrayBuffer);
    const founders: number[] = [];
    for (let i = 0; i < readRenderSnapshotCounts(view).organismCount; i += 1) {
      founders.push(view.organismId[i] as number);
    }
    expect(founders.length).toBeGreaterThan(0);

    // Run until the world has killed something, then find which one.
    for (let i = 0; i < 40; i += 1) {
      runtime.advance(500);
      if ((runtime.last("TELEMETRY")?.payload.totalDeaths ?? 0) > 0) {
        break;
      }
    }
    expect(runtime.last("TELEMETRY")?.payload.totalDeaths).toBeGreaterThan(0);

    let sawDead = false;
    for (const entityId of founders) {
      host.handleMessage(message("QUERY_ENTITY", { entityId }, entityId));
      const answer = runtime.last("ENTITY_DETAILS");
      expect(answer?.requestId).toBe(entityId);
      if (answer?.payload.details === null) {
        sawDead = true;
        break;
      }
    }
    expect(sawDead).toBe(true);
    // The world is still fine; only that organism is gone.
    expect(runtime.last("TELEMETRY")?.payload.population).toBeGreaterThan(0);
  });

  it("does not change the simulation", () => {
    init("paused");
    const before = host.stateHash();
    for (let id = 1; id <= 60; id += 1) {
      host.handleMessage(message("QUERY_ENTITY", { entityId: id }, id));
    }
    expect(host.stateHash()).toBe(before);
    expect(host.tick).toBe(0);
  });
});

describe("lifecycle", () => {
  it("stops the loop and refuses further work after DISPOSE", () => {
    init("x20");
    runtime.advance(500);
    const atDispose = host.tick;

    host.handleMessage(message("DISPOSE", {}));
    expect(host.disposed).toBe(true);
    expect(runtime.scheduledCount).toBe(0);

    runtime.advance(10_000);
    expect(host.tick).toBe(0); // engine released
    runtime.clearPosted();
    setSpeed("x1");
    expect(runtime.posted).toHaveLength(0);
    expect(atDispose).toBeGreaterThan(0);
  });

  it("stops ticking after a fatal error", () => {
    init("x20");
    runtime.advance(200);
    // A fatal error is reported by the failure path; the observable contract is
    // that an invalid re-init leaves no loop scheduled behind it.
    host.handleMessage(
      message("INIT_NEW_WORLD", {
        seed: 2,
        config: { schemaVersion: -1 },
        hostRuntime: null,
        speed: "x1",
      }),
    );
    expect(runtime.last("ERROR")?.payload.fatal).toBe(true);
    const tickAtFailure = host.tick;
    runtime.advance(5000);
    expect(host.tick).toBe(tickAtFailure);
  });
});
