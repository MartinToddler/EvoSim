/**
 * Worker/headless determinism check on the REAL default world.
 *
 * `SimulationHost.test.ts` proves the same property on a small 64² world, fast
 * enough to run in the suite. This script proves it where it actually matters:
 * `DEFAULT_CONFIG`, seed `0xE0A12026` — the world the golden fixture describes
 * and the world the browser opens — by driving the host through an erratic
 * schedule and comparing against both a plain `stepMany` and the committed
 * golden hash.
 *
 * It is a script rather than a test because a few thousand ticks of the full
 * 256² world costs far more than a unit test should, and `pnpm test` already
 * runs the same assertion at a size that fits.
 *
 *   pnpm exec tsx scripts/workerEquivalence.ts [--ticks 1000]
 */
import { DEFAULT_CONFIG, ENGINE_VERSION, SimulationEngine } from "@eon/engine";
import { PROTOCOL_VERSION, type WorkerToMainMessage } from "@eon/protocol";
import { SimulationHost, type HostTimerHandle } from "../apps/web/src/worker/SimulationHost";
import golden from "../packages/engine/src/fixtures/goldenStateHashes.json" with { type: "json" };

const SEED = 0xe0a12026;

function parseTicks(): number {
  const index = process.argv.indexOf("--ticks");
  if (index < 0) {
    return 1000;
  }
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--ticks must be a positive integer, got ${String(process.argv[index + 1])}`);
  }
  return value;
}

/** Deterministic clock + scheduler, the same shape the unit tests use. */
class Runtime {
  nowMs = 0;
  readonly posted: WorkerToMainMessage[] = [];
  #tasks: { id: number; at: number; run: () => void }[] = [];
  #next = 1;

  readonly clock = { now: (): number => this.nowMs };
  readonly scheduler = {
    schedule: (run: () => void, delayMs: number): HostTimerHandle => {
      const id = this.#next;
      this.#next += 1;
      this.#tasks.push({ id, at: this.nowMs + Math.max(0, delayMs), run });
      return id;
    },
    cancel: (handle: HostTimerHandle): void => {
      this.#tasks = this.#tasks.filter((task) => task.id !== handle);
    },
  };
  readonly port = {
    post: (message: WorkerToMainMessage, transfer?: readonly ArrayBuffer[]): void => {
      this.posted.push(
        transfer !== undefined && transfer.length > 0
          ? structuredClone(message, { transfer: transfer as ArrayBuffer[] })
          : message,
      );
    },
  };

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (let guard = 0; guard < 1_000_000; guard += 1) {
      let next: { id: number; at: number; run: () => void } | null = null;
      for (const task of this.#tasks) {
        if (task.at <= target && (next === null || task.at < next.at)) {
          next = task;
        }
      }
      if (next === null) {
        this.nowMs = Math.max(this.nowMs, target);
        return;
      }
      this.#tasks = this.#tasks.filter((task) => task.id !== next.id);
      this.nowMs = Math.max(this.nowMs, next.at);
      next.run();
    }
    throw new Error("scheduler made no progress");
  }

  send(type: string, payload: unknown, requestId?: number): unknown {
    return requestId === undefined
      ? { protocolVersion: PROTOCOL_VERSION, type, payload }
      : { protocolVersion: PROTOCOL_VERSION, requestId, type, payload };
  }
}

const targetTick = parseTicks();
const runtime = new Runtime();
const host = new SimulationHost({
  clock: runtime.clock,
  scheduler: runtime.scheduler,
  port: runtime.port,
});

console.log(
  `engine ${ENGINE_VERSION} · protocol ${PROTOCOL_VERSION} · seed 0x${SEED.toString(16)}`,
);
console.log(`target tick ${targetTick}\n`);

const startedAt = Date.now();
host.handleMessage(
  runtime.send("INIT_NEW_WORLD", { seed: SEED, config: null, hostRuntime: null, speed: "x1" }),
);

// An intentionally awkward schedule: nothing here may change the outcome.
runtime.advance(1000); // 20 ticks at 1x
host.handleMessage(runtime.send("SET_RUN_STATE", { speed: "paused" }));
runtime.advance(30_000); // a long pause must not accrue a debt
host.handleMessage(runtime.send("SET_RUN_STATE", { speed: "x20" }));
runtime.advance(500); // +200
host.handleMessage(runtime.send("QUERY_ENTITY", { entityId: 7 }, 1));
host.handleMessage(runtime.send("SET_RUN_STATE", { speed: "x5" }));
runtime.advance(1000); // +100
host.handleMessage(runtime.send("SET_RENDER_STREAM", { enabled: false }));
runtime.advance(1000);
host.handleMessage(runtime.send("SET_RENDER_STREAM", { enabled: true }));
host.handleMessage(runtime.send("SET_RUN_STATE", { speed: "paused" }));
runtime.advance(5000);

// Now let the scheduler carry the bulk of the run, so the comparison is about
// ticks the loop actually produced rather than ticks a synchronous top-up did.
host.handleMessage(runtime.send("SET_RUN_STATE", { speed: "x100" }));
while (host.tick < targetTick - 200) {
  runtime.advance(100);
}
host.handleMessage(runtime.send("SET_RUN_STATE", { speed: "paused" }));

const scheduledTicks = host.tick;
// Top the world up to the target through the protocol.
host.handleMessage(runtime.send("QUERY_STATE_HASH", { targetTick }, 2));
const answer = runtime.posted.findLast((message) => message.type === "STATE_HASH");
if (answer === undefined || answer.type !== "STATE_HASH") {
  throw new Error("worker did not answer QUERY_STATE_HASH");
}
const workerMs = Date.now() - startedAt;

const headlessStart = Date.now();
const headless = new SimulationEngine({ seed: SEED, config: DEFAULT_CONFIG });
headless.stepMany(targetTick);
const headlessHash = headless.computeStateHash();
const headlessMs = Date.now() - headlessStart;

const checkpoints = golden.checkpoints as Record<string, string>;
const goldenHash = checkpoints[String(targetTick)];

console.log(`ticks executed by the scheduler   ${scheduledTicks}`);
console.log(`ticks topped up through the port  ${targetTick - scheduledTicks}`);
console.log(
  `render snapshots produced         ${runtime.posted.filter((m) => m.type === "RENDER_SNAPSHOT").length}`,
);
console.log(
  `telemetry frames produced         ${runtime.posted.filter((m) => m.type === "TELEMETRY").length}`,
);
console.log("");
console.log(`worker   hash @ ${answer.payload.tick}  ${answer.payload.hash}   (${workerMs} ms)`);
console.log(`headless hash @ ${targetTick}  ${headlessHash}   (${headlessMs} ms)`);
if (goldenHash !== undefined) {
  console.log(`golden   hash @ ${targetTick}  ${goldenHash}`);
}

const workerMatches = answer.payload.hash === headlessHash;
const goldenMatches = goldenHash === undefined || headlessHash === goldenHash;
console.log("");
console.log(`worker === headless : ${workerMatches ? "MATCH" : "MISMATCH"}`);
console.log(
  `headless === golden : ${goldenHash === undefined ? "n/a" : goldenMatches ? "MATCH" : "MISMATCH"}`,
);

if (!workerMatches || !goldenMatches) {
  process.exitCode = 1;
}
