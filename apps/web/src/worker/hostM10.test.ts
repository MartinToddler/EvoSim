import { SimulationEngine } from "@eon/engine";
import { decodeDurableSnapshot, readSnapshotHeader, SNAPSHOT_MAGIC } from "@eon/persistence/codec";
import type { SnapshotDataPayload, StateHashPayload } from "@eon/protocol";
import { describe, expect, it } from "vitest";
import { SimulationHost } from "./SimulationHost";
import { TEST_SEED, TestRuntime, createTestConfig, message } from "./hostTestSupport";

/**
 * Milestone 10 host extensions, end to end through the message port:
 * REQUEST_SAVE → SNAPSHOT_DATA, LOAD_WORLD → WORLD_READY, and the property the
 * whole milestone exists for — a world saved by one host and loaded into a
 * *different* host continues into the same future.
 *
 * These run through `TestRuntime.port`, which performs real structured clones
 * with real transfers, so a save that is only correct because sender and
 * receiver share memory fails here.
 */

function createReadyHost(speed: "paused" | "x1" = "paused"): {
  runtime: TestRuntime;
  host: SimulationHost;
} {
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
      speed,
    }),
  );
  return { runtime, host };
}

/** Run exactly `ticks` ticks through the host's own deterministic path. */
function runTo(host: SimulationHost, runtime: TestRuntime, tick: number): StateHashPayload {
  host.handleMessage(message("QUERY_STATE_HASH", { targetTick: tick }, 1));
  const answer = runtime.last("STATE_HASH");
  if (answer === undefined) {
    throw new Error("no STATE_HASH answer");
  }
  return answer.payload;
}

function save(host: SimulationHost, runtime: TestRuntime, requestId = 2): SnapshotDataPayload {
  host.handleMessage(message("REQUEST_SAVE", { reason: "manual" }, requestId));
  const answer = runtime.last("SNAPSHOT_DATA");
  if (answer === undefined) {
    throw new Error("no SNAPSHOT_DATA answer");
  }
  return answer.payload;
}

describe("REQUEST_SAVE", () => {
  it("answers with a durable container describing the world", () => {
    const { runtime, host } = createReadyHost();
    const hash = runTo(host, runtime, 120);
    const payload = save(host, runtime);

    expect(payload.tick).toBe(120);
    expect(payload.stateHash).toBe(hash.hash);
    expect(payload.reason).toBe("manual");
    expect(payload.seed).toBe(TEST_SEED);

    const bytes = new Uint8Array(payload.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 8))).toBe(SNAPSHOT_MAGIC);
    const header = readSnapshotHeader(bytes);
    expect(header.tick).toBe(120);
    expect(header.stateHash).toBe(hash.hash);
    expect(header.engineVersion).toBe(payload.engineVersion);
  });

  it("echoes the reason so an autosave is distinguishable from a click", () => {
    const { runtime, host } = createReadyHost();
    host.handleMessage(message("REQUEST_SAVE", { reason: "autosave" }, 7));
    expect(runtime.last("SNAPSHOT_DATA")?.payload.reason).toBe("autosave");
    expect(runtime.last("SNAPSHOT_DATA")?.requestId).toBe(7);
  });

  it("does not disturb the world it saves", () => {
    const { runtime, host } = createReadyHost();
    const before = runTo(host, runtime, 200);
    save(host, runtime, 3);
    save(host, runtime, 4);

    // Same tick, same hash: the two saves in between changed nothing.
    expect(host.stateHash()).toBe(before.hash);

    const control = createReadyHost();
    const controlHash = runTo(control.host, control.runtime, 400);
    expect(runTo(host, runtime, 400).hash).toBe(controlHash.hash);
  });

  it("fails cleanly when there is no world yet", () => {
    const runtime = new TestRuntime();
    const host = new SimulationHost({
      clock: runtime.clock,
      scheduler: runtime.scheduler,
      port: runtime.port,
    });
    host.handleMessage(message("REQUEST_SAVE", { reason: "manual" }, 1));
    const error = runtime.last("ERROR");
    expect(error?.payload.message).toMatch(/cannot save before a world is initialized/);
    expect(error?.payload.fatal).toBe(false);
  });
});

describe("LOAD_WORLD", () => {
  it("resumes a saved world in a fresh host, into the same future", () => {
    // Host A: run to 250, save, then keep running to 900.
    const a = createReadyHost();
    runTo(a.host, a.runtime, 250);
    const saved = save(a.host, a.runtime);
    const controlHash = runTo(a.host, a.runtime, 900).hash;

    // Host B: a genuinely different host, given only the bytes.
    const b = new TestRuntime();
    const hostB = new SimulationHost({ clock: b.clock, scheduler: b.scheduler, port: b.port });
    hostB.handleMessage(
      message("LOAD_WORLD", { snapshot: saved.buffer, hostRuntime: null, speed: "paused" }),
    );

    const ready = b.last("WORLD_READY");
    expect(ready).toBeDefined();
    expect(ready?.payload.world.seed).toBe(TEST_SEED);
    expect(hostB.stateHash()).toBe(saved.stateHash);

    expect(runTo(hostB, b, 900).hash).toBe(controlHash);
  });

  it("ships a first picture and telemetry for the restored world", () => {
    const a = createReadyHost();
    runTo(a.host, a.runtime, 300);
    const saved = save(a.host, a.runtime);

    const b = new TestRuntime();
    const hostB = new SimulationHost({ clock: b.clock, scheduler: b.scheduler, port: b.port });
    hostB.handleMessage(
      message("LOAD_WORLD", { snapshot: saved.buffer, hostRuntime: null, speed: "paused" }),
    );

    // A loaded world must be visible immediately, exactly like a new one.
    expect(b.last("WORLD_READY")?.payload.terrain.byteLength).toBeGreaterThan(0);
    expect(b.all("RENDER_SNAPSHOT").length).toBeGreaterThan(0);
  });

  it("resumes at the requested speed", () => {
    const a = createReadyHost();
    runTo(a.host, a.runtime, 100);
    const saved = save(a.host, a.runtime);

    const b = new TestRuntime();
    const hostB = new SimulationHost({ clock: b.clock, scheduler: b.scheduler, port: b.port });
    hostB.handleMessage(
      message("LOAD_WORLD", { snapshot: saved.buffer, hostRuntime: null, speed: "x1" }),
    );
    b.advance(1000);
    expect(hostB.tick).toBeGreaterThan(100);
  });

  it("carries a pending command across the load and applies it exactly once", () => {
    const a = createReadyHost();
    runTo(a.host, a.runtime, 100);
    a.host.handleMessage(
      message(
        "QUEUE_COMMAND",
        {
          command: {
            kind: "setGlobalTemperature",
            offsetCentiC: 700,
            targetTick: 150,
          },
        },
        9,
      ),
    );
    expect(a.runtime.last("COMMAND_RESULT")?.payload.result.accepted).toBe(true);

    const saved = save(a.host, a.runtime);
    const controlHash = runTo(a.host, a.runtime, 400).hash;

    const b = new TestRuntime();
    const hostB = new SimulationHost({ clock: b.clock, scheduler: b.scheduler, port: b.port });
    hostB.handleMessage(
      message("LOAD_WORLD", { snapshot: saved.buffer, hostRuntime: null, speed: "paused" }),
    );
    expect(runTo(hostB, b, 400).hash).toBe(controlHash);
  });

  it("refuses a corrupt save and leaves the running world alone", () => {
    const { runtime, host } = createReadyHost();
    const before = runTo(host, runtime, 150);
    const saved = save(host, runtime);

    const damaged = new Uint8Array(saved.buffer.slice(0));
    damaged[200] = (damaged[200] as number) ^ 0xff;

    host.handleMessage(
      message("LOAD_WORLD", { snapshot: damaged.buffer, hostRuntime: null, speed: "paused" }),
    );

    const error = runtime.last("ERROR");
    expect(error?.payload.message).toMatch(/checksum/);
    // Non-fatal, and the world that was running is untouched: same tick, same
    // hash, and it still steps into the same future.
    expect(error?.payload.fatal).toBe(false);
    expect(host.tick).toBe(150);
    expect(host.stateHash()).toBe(before.hash);

    const control = createReadyHost();
    expect(runTo(host, runtime, 400).hash).toBe(runTo(control.host, control.runtime, 400).hash);
  });

  it("refuses bytes that are not a snapshot at all", () => {
    const { runtime, host } = createReadyHost();
    host.handleMessage(
      message("LOAD_WORLD", {
        snapshot: new Uint8Array(512).buffer,
        hostRuntime: null,
        speed: "paused",
      }),
    );
    expect(runtime.last("ERROR")?.payload.message).toMatch(/magic/);
    expect(host.tick).toBe(0);
  });

  it("agrees with a headless engine restored from the same bytes", () => {
    // The Worker path and the pure-engine path must produce the same world from
    // one file — otherwise "the same save" means two different things.
    const { runtime, host } = createReadyHost();
    runTo(host, runtime, 220);
    const saved = save(host, runtime);
    const bytes = new Uint8Array(saved.buffer.slice(0));

    const b = new TestRuntime();
    const hostB = new SimulationHost({ clock: b.clock, scheduler: b.scheduler, port: b.port });
    hostB.handleMessage(
      message("LOAD_WORLD", {
        snapshot: bytes.buffer.slice(0),
        hostRuntime: null,
        speed: "paused",
      }),
    );
    const workerHash = runTo(hostB, b, 700).hash;

    // Decoded through the same public container the Worker used.
    const headless = SimulationEngine.fromSnapshot(decodeDurableSnapshot(bytes).snapshot);
    headless.stepMany(700 - 220);
    expect(headless.computeStateHash()).toBe(workerHash);
  });
});

describe("a loaded world does not inherit the previous world's host state", () => {
  /**
   * The Milestone 6 review found that a replacement world inherited
   * `behindTarget` and called it "unreachable via the app today (one worker per
   * world); reachable via the protocol". LOAD_WORLD makes it reachable through
   * the app: a load replaces the world *inside the running Worker*, so the
   * flags that describe the old world's loop are still set when the new one is
   * announced. A restored world that opens paused would then sit there
   * reporting "Behind" about a loop that no longer exists.
   */
  it("reports the restored world's own pacing, not the replaced world's", () => {
    const { runtime, host } = createReadyHost();
    runTo(host, runtime, 50);
    const saved = save(host, runtime);

    // Fall behind: a long stall at a paced speed leaves the loop owing ticks.
    host.handleMessage(message("SET_RUN_STATE", { speed: "x100" }));
    runtime.readCostMs = 2;
    runtime.advance(30_000);
    expect(runtime.last("TELEMETRY")?.payload.behindTarget).toBe(true);

    host.handleMessage(message("SET_RUN_STATE", { speed: "paused" }));
    runtime.clearPosted();
    host.handleMessage(
      message("LOAD_WORLD", { snapshot: saved.buffer, hostRuntime: null, speed: "paused" }),
    );

    // The world that just opened is paused at tick 50 and has never run here.
    expect(runtime.last("WORLD_READY")?.payload.telemetry.behindTarget).toBe(false);
    expect(runtime.last("WORLD_READY")?.payload.telemetry.tick).toBe(50);
  });
});
