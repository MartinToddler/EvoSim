import { InterventionKind, SimulationEngine } from "@eon/engine";
import { decodeDurableSnapshot } from "@eon/persistence/codec";
import type {
  HistoricalModeReadyPayload,
  RewindProgressPayload,
  SnapshotDataPayload,
} from "@eon/protocol";
import { describe, expect, it } from "vitest";
import { SimulationHost } from "./SimulationHost";
import { TEST_SEED, TestRuntime, createTestConfig, message } from "./hostTestSupport";

/**
 * Milestone 11 host behaviour, end to end through the message port: rewinding
 * into a historical preview, returning to the present, and producing a branch
 * origin.
 *
 * The properties under test are the ones a rewind can silently get wrong — the
 * preview shows the requested tick, the live world does not move while it is
 * open, nothing can edit the present from inside it, and returning leaves the
 * world exactly where it was.
 */

function createHost(): { runtime: TestRuntime; host: SimulationHost } {
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

/** Step the live world to `tick` through the host's own deterministic path. */
function runTo(host: SimulationHost, tick: number): string {
  host.handleMessage(message("QUERY_STATE_HASH", { targetTick: tick }, 1));
  return host.stateHash() ?? "";
}

function save(host: SimulationHost, runtime: TestRuntime, requestId = 2): SnapshotDataPayload {
  host.handleMessage(message("REQUEST_SAVE", { reason: "manual" }, requestId));
  const answer = runtime.last("SNAPSHOT_DATA");
  if (answer === undefined) {
    throw new Error("no SNAPSHOT_DATA answer");
  }
  return answer.payload;
}

/** Drive a rewind to completion, returning everything the host reported. */
function rewind(
  host: SimulationHost,
  runtime: TestRuntime,
  snapshot: ArrayBuffer,
  targetTick: number,
  requestId = 7,
): { progress: RewindProgressPayload[]; ready: HistoricalModeReadyPayload | undefined } {
  host.handleMessage(message("REQUEST_REWIND", { snapshot, targetTick }, requestId));
  // The replay runs on the host's scheduler, one slice per task, exactly as it
  // does in a Worker.
  let guard = 0;
  while (runtime.last("HISTORICAL_MODE_READY") === undefined && guard < 10_000) {
    if (!runtime.runNext()) {
      break;
    }
    guard += 1;
  }
  return {
    progress: runtime.all("REWIND_PROGRESS").map((m) => m.payload),
    ready: runtime.last("HISTORICAL_MODE_READY")?.payload,
  };
}

describe("REQUEST_REWIND", () => {
  it("reconstructs the requested tick and announces the preview", () => {
    const { runtime, host } = createHost();
    runTo(host, 40);
    const early = save(host, runtime);
    const presentHash = runTo(host, 120);
    runtime.clearPosted();

    const { ready } = rewind(host, runtime, early.buffer, 80);

    expect(ready).toBeDefined();
    expect(ready?.tick).toBe(80);
    expect(ready?.presentTick).toBe(120);
    // The preview is a real reconstruction: its hash is the hash of tick 80,
    // not of the save it started from and not of the present.
    expect(ready?.stateHash).not.toBe(early.stateHash);
    expect(ready?.stateHash).not.toBe(presentHash);
  });

  it("matches an uninterrupted run to the same tick", () => {
    const { runtime, host } = createHost();
    runTo(host, 40);
    const early = save(host, runtime);
    runTo(host, 120);

    const reference = SimulationEngine.fromSnapshot(
      decodeDurableSnapshot(new Uint8Array(early.buffer.slice(0))).snapshot,
    );
    reference.stepMany(40);

    runtime.clearPosted();
    const { ready } = rewind(host, runtime, early.buffer, 80);
    expect(ready?.stateHash).toBe(reference.computeStateHash());
  });

  it("reports progress that starts at zero and ends on the target", () => {
    const { runtime, host } = createHost();
    runTo(host, 20);
    const early = save(host, runtime);
    runTo(host, 200);
    runtime.clearPosted();

    const { progress } = rewind(host, runtime, early.buffer, 180);

    expect(progress.length).toBeGreaterThan(1);
    expect(progress[0]).toMatchObject({ fromTick: 20, targetTick: 180, ticksReplayed: 0 });
    expect(progress.at(-1)).toMatchObject({
      currentTick: 180,
      ticksReplayed: 160,
      ticksTotal: 160,
    });
  });

  it("leaves the live world where it was", () => {
    const { runtime, host } = createHost();
    runTo(host, 40);
    const early = save(host, runtime);
    const presentHash = runTo(host, 120);
    runtime.clearPosted();

    rewind(host, runtime, early.buffer, 60);

    // `stateHash()` reports the LIVE engine — the present is untouched, and it
    // did not creep forward while the preview was reconstructed.
    expect(host.stateHash()).toBe(presentHash);
  });

  it("refuses a target the world has not reached", () => {
    const { runtime, host } = createHost();
    runTo(host, 40);
    const early = save(host, runtime);
    runtime.clearPosted();

    host.handleMessage(message("REQUEST_REWIND", { snapshot: early.buffer, targetTick: 5000 }, 9));
    expect(runtime.last("ERROR")?.payload.message).toMatch(/has only reached/);
  });

  it("refuses a save that is later than the target", () => {
    const { runtime, host } = createHost();
    runTo(host, 100);
    const late = save(host, runtime);
    runTo(host, 200);
    runtime.clearPosted();

    host.handleMessage(message("REQUEST_REWIND", { snapshot: late.buffer, targetTick: 50 }, 9));
    expect(runtime.last("ERROR")?.payload.message).toMatch(/replays forward from an earlier save/);
  });
});

describe("a rewind replays the history the world actually had", () => {
  /**
   * The defect this pins (docs/06 §24 step 3): a save at tick S carries only
   * the commands accepted by S. An intervention fired AFTER the last save but
   * targeting a tick inside the replay window used to be omitted from the
   * reconstruction, so the "preview" showed a past that never happened — and
   * a branch taken from it persisted that fiction as the parent's history.
   * The host now hands the live world's own command log to the replay.
   */
  function worldWithLateCommand(): {
    runtime: TestRuntime;
    host: SimulationHost;
    save: SnapshotDataPayload;
    presentTick: number;
  } {
    const { runtime, host } = createHost();
    runTo(host, 40);
    // The only save is at tick 40 — BEFORE the command exists.
    const early = save(host, runtime);
    host.handleMessage(
      message("QUEUE_COMMAND", { command: { kind: "setGlobalTemperature", offsetCentiC: 900 } }, 3),
    );
    runTo(host, 120);
    runtime.clearPosted();
    return { runtime, host, save: early, presentTick: 120 };
  }

  it("applies a command issued after the save it replays from", () => {
    const { runtime, host, save: early } = worldWithLateCommand();

    // The reference: the same save, replayed with the same command applied at
    // the same tick, built independently of the host.
    const reference = SimulationEngine.fromSnapshot(
      decodeDurableSnapshot(new Uint8Array(early.buffer.slice(0))).snapshot,
    );
    expect(
      reference.queueCommand({ kind: InterventionKind.SetGlobalTemperature, offsetCentiC: 900 })
        .accepted,
    ).toBe(true);
    reference.stepMany(60);

    const { ready } = rewind(host, runtime, early.buffer, 100);
    expect(ready?.tick).toBe(100);
    expect(ready?.stateHash).toBe(reference.computeStateHash());

    // And the counterfeit it used to produce — the same replay with no command
    // — is a genuinely different world, so this is not a vacuous assertion.
    const withoutCommand = SimulationEngine.fromSnapshot(
      decodeDurableSnapshot(new Uint8Array(early.buffer.slice(0))).snapshot,
    );
    withoutCommand.stepMany(60);
    expect(ready?.stateHash).not.toBe(withoutCommand.computeStateHash());
  });

  it("branches a history that includes the late command", () => {
    const { runtime, host, save: early } = worldWithLateCommand();
    rewind(host, runtime, early.buffer, 100);
    const previewHash = runtime.last("HISTORICAL_MODE_READY")?.payload.stateHash;
    runtime.clearPosted();

    host.handleMessage(message("CREATE_BRANCH", { branchTick: 100 }, 11));
    const origin = runtime.last("SNAPSHOT_DATA")?.payload;
    expect(origin?.tick).toBe(100);
    expect(origin?.stateHash).toBe(previewHash);
    // The branch inherits the command as applied history, not as a pending one
    // it would re-run.
    const restored = SimulationEngine.fromSnapshot(
      decodeDurableSnapshot(new Uint8Array((origin as SnapshotDataPayload).buffer)).snapshot,
    );
    expect(restored.commands.length).toBe(1);
    expect(restored.commands.pendingCount).toBe(0);
  });
});

describe("a preview is read-only", () => {
  function previewing(): { runtime: TestRuntime; host: SimulationHost; presentHash: string } {
    const { runtime, host } = createHost();
    runTo(host, 40);
    const early = save(host, runtime);
    const presentHash = runTo(host, 120);
    runtime.clearPosted();
    rewind(host, runtime, early.buffer, 60);
    runtime.clearPosted();
    return { runtime, host, presentHash };
  }

  it("refuses interventions", () => {
    const { runtime, host, presentHash } = previewing();
    host.handleMessage(
      message("QUEUE_COMMAND", { command: { kind: "setGlobalTemperature", offsetCentiC: 500 } }, 3),
    );

    expect(runtime.last("ERROR")?.payload.message).toMatch(/disabled while previewing/);
    expect(runtime.last("COMMAND_RESULT")).toBeUndefined();
    expect(host.stateHash()).toBe(presentHash);
  });

  it("refuses saves", () => {
    const { runtime, host } = previewing();
    host.handleMessage(message("REQUEST_SAVE", { reason: "manual" }, 4));

    expect(runtime.last("ERROR")?.payload.message).toMatch(/cannot save while previewing/);
    expect(runtime.last("SNAPSHOT_DATA")).toBeUndefined();
  });

  it("refuses to step the preview forward through a state-hash query", () => {
    // The one mutating message that used to have no preview guard: with a
    // target tick it stepped the VIEW engine, silently moving the previewed
    // tick and making a branch from that preview fail its exact-tick match.
    const { runtime, host, presentHash } = previewing();
    const before = runtime.last("HISTORICAL_MODE_READY")?.payload;

    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: 90 }, 12));

    expect(runtime.last("ERROR")?.payload.message).toMatch(/history is read-only/);
    // Neither engine moved: a branch at the previewed tick still succeeds.
    expect(host.stateHash()).toBe(presentHash);
    runtime.clearPosted();
    host.handleMessage(message("CREATE_BRANCH", { branchTick: before?.tick ?? -1 }, 13));
    expect(runtime.last("SNAPSHOT_DATA")?.payload.tick).toBe(before?.tick);
  });

  it("ignores time controls, so the present cannot start running underneath it", () => {
    const { runtime, host, presentHash } = previewing();
    host.handleMessage(message("SET_RUN_STATE", { speed: "max" }));
    runtime.advance(500);

    expect(host.stateHash()).toBe(presentHash);
  });

  it("answers queries about the previewed tick, not the present", () => {
    const { runtime, host } = previewing();
    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: 60 }, 5));
    const answer = runtime.last("STATE_HASH");
    expect(answer?.payload.tick).toBe(60);
  });
});

describe("RETURN_TO_PRESENT", () => {
  it("restores the live world's projection without reloading it", () => {
    const { runtime, host } = createHost();
    runTo(host, 40);
    const early = save(host, runtime);
    const presentHash = runTo(host, 120);
    rewind(host, runtime, early.buffer, 60);
    runtime.clearPosted();

    host.handleMessage(message("RETURN_TO_PRESENT", {}));

    expect(host.stateHash()).toBe(presentHash);
    expect(runtime.last("TERRAIN_SNAPSHOT")?.payload.tick).toBe(120);
    expect(runtime.last("TELEMETRY")?.payload.tick).toBe(120);

    // And the world runs on from exactly where it stopped. Stepped through the
    // deterministic query path rather than the paced loop: how many ticks a
    // wall-clock second buys is not what this test is about.
    host.handleMessage(message("QUERY_STATE_HASH", { targetTick: 200 }, 6));
    expect(runtime.last("STATE_HASH")?.payload.tick).toBe(200);
  });

  it("is harmless when no preview is open", () => {
    const { runtime, host } = createHost();
    const presentHash = runTo(host, 30);
    runtime.clearPosted();

    host.handleMessage(message("RETURN_TO_PRESENT", {}));
    expect(host.stateHash()).toBe(presentHash);
  });
});

describe("CREATE_BRANCH", () => {
  it("answers with a container holding the previewed state", () => {
    const { runtime, host } = createHost();
    runTo(host, 40);
    const early = save(host, runtime);
    runTo(host, 120);
    const { ready } = rewind(host, runtime, early.buffer, 60);
    runtime.clearPosted();

    host.handleMessage(message("CREATE_BRANCH", { branchTick: 60 }, 11));
    const answer = runtime.last("SNAPSHOT_DATA");

    expect(answer?.payload.reason).toBe("branch");
    expect(answer?.payload.tick).toBe(60);
    expect(answer?.payload.stateHash).toBe(ready?.stateHash);

    // The bytes really are that state: decoding and restoring them reproduces
    // the preview's hash.
    const decoded = decodeDurableSnapshot(
      new Uint8Array(answer?.payload.buffer ?? new ArrayBuffer(0)),
    );
    const restored = SimulationEngine.fromSnapshot(decoded.snapshot);
    expect(restored.tick).toBe(60);
    expect(restored.computeStateHash()).toBe(ready?.stateHash);
  });

  it("refuses a branch point that is not the previewed tick", () => {
    const { runtime, host } = createHost();
    runTo(host, 40);
    const early = save(host, runtime);
    runTo(host, 120);
    rewind(host, runtime, early.buffer, 60);
    runtime.clearPosted();

    host.handleMessage(message("CREATE_BRANCH", { branchTick: 61 }, 12));
    expect(runtime.last("ERROR")?.payload.message).toMatch(/does not match the previewed tick/);
    expect(runtime.last("SNAPSHOT_DATA")).toBeUndefined();
  });

  it("refuses outside historical mode", () => {
    const { runtime, host } = createHost();
    runTo(host, 40);
    runtime.clearPosted();

    host.handleMessage(message("CREATE_BRANCH", { branchTick: 40 }, 13));
    expect(runtime.last("ERROR")?.payload.message).toMatch(/open historical preview/);
  });

  it("does not disturb the live world", () => {
    const { runtime, host } = createHost();
    runTo(host, 40);
    const early = save(host, runtime);
    const presentHash = runTo(host, 120);
    rewind(host, runtime, early.buffer, 60);

    host.handleMessage(message("CREATE_BRANCH", { branchTick: 60 }, 14));
    host.handleMessage(message("RETURN_TO_PRESENT", {}));

    expect(host.stateHash()).toBe(presentHash);
  });
});
