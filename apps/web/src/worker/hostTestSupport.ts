import { DEFAULT_CONFIG, cloneConfig, type SimulationConfig } from "@eon/engine";
import {
  PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type WorkerToMainMessage,
  type WorkerToMainType,
} from "@eon/protocol";
import type { HostClock, HostPort, HostScheduler, HostTimerHandle } from "./SimulationHost";

/**
 * Test doubles for the three browser capabilities {@link SimulationHost} needs.
 *
 * The host is the piece of this milestone most likely to contain a subtle bug —
 * double loops, pause races, catch-up bursts, snapshot backlogs — and every one
 * of those is a *timing* bug. Timing bugs cannot be tested against a real clock
 * without either flakiness or a stopwatch, so the clock and the scheduler are
 * injected and this file supplies deterministic ones. A test says "advance 250
 * milliseconds" and gets exactly the ticks that implies, every run.
 *
 * This module is imported only by tests. It lives beside the code it tests
 * rather than under a separate tree so the fake and the real wiring in
 * `simulation.worker.ts` stay visibly the same shape.
 */

interface ScheduledTask {
  id: number;
  at: number;
  callback: () => void;
}

/**
 * Deterministic clock, scheduler and message port.
 *
 * ## `readCostMs`
 *
 * A real tick takes time, and the host's slice budget is what stops MAX mode
 * monopolizing the Worker. With a clock that never moves, a slice would only
 * ever end on its tick cap and the budget logic would go untested. So each
 * clock *read* can be charged a cost: with `readCostMs = 0.5` and a 10 ms
 * budget the host gets about 20 ticks per slice, which is the shape of a real
 * MAX slice.
 *
 * Tests that care about cadence rather than throughput leave it at 0 and move
 * the clock explicitly.
 */
export class TestRuntime {
  nowMs = 0;
  readCostMs = 0;

  /** Everything the host has posted, in order, after transfer semantics. */
  readonly posted: WorkerToMainMessage[] = [];
  /** How many times each message type was posted. */
  readonly postCounts = new Map<string, number>();

  #tasks: ScheduledTask[] = [];
  #nextId = 1;
  /** Total timers ever scheduled — one per loop slice, so it counts yields. */
  scheduleCalls = 0;

  readonly clock: HostClock = {
    now: (): number => {
      const value = this.nowMs;
      this.nowMs += this.readCostMs;
      return value;
    },
  };

  readonly scheduler: HostScheduler = {
    schedule: (callback: () => void, delayMs: number): HostTimerHandle => {
      const id = this.#nextId;
      this.#nextId += 1;
      this.scheduleCalls += 1;
      this.#tasks.push({ id, at: this.nowMs + Math.max(0, delayMs), callback });
      return id;
    },
    cancel: (handle: HostTimerHandle): void => {
      this.#tasks = this.#tasks.filter((task) => task.id !== handle);
    },
  };

  /**
   * Message port that models `postMessage` faithfully, transfers included.
   *
   * Transferred buffers really are detached here, via `structuredClone` with a
   * transfer list — the same mechanism `postMessage` uses. Without that, a bug
   * where the host keeps writing into a buffer it already sent away would pass
   * every test and fail in the browser.
   */
  readonly port: HostPort = {
    post: (message: WorkerToMainMessage, transfer?: readonly ArrayBuffer[]): void => {
      const delivered =
        transfer !== undefined && transfer.length > 0
          ? structuredClone(message, { transfer: transfer as ArrayBuffer[] })
          : message;
      this.posted.push(delivered);
      this.postCounts.set(delivered.type, (this.postCounts.get(delivered.type) ?? 0) + 1);
    },
  };

  /** Timers currently scheduled. More than one means more than one loop. */
  get scheduledCount(): number {
    return this.#tasks.length;
  }

  /**
   * Advance the wall clock by `ms`, running every task that comes due.
   *
   * Tasks scheduled by a task are honoured, which is what makes a
   * self-rescheduling loop actually loop. The iteration bound is a safety net
   * for a loop that reschedules with zero delay under a clock that never moves
   * — a real possibility in MAX mode with `readCostMs = 0`, and a hang rather
   * than a failure without it.
   */
  advance(ms: number, maxIterations = 100_000): void {
    const target = this.nowMs + ms;
    for (let i = 0; i < maxIterations; i += 1) {
      const next = this.#earliestDueBy(target);
      if (next === null) {
        this.nowMs = Math.max(this.nowMs, target);
        return;
      }
      this.#tasks = this.#tasks.filter((task) => task.id !== next.id);
      this.nowMs = Math.max(this.nowMs, next.at);
      next.callback();
    }
    throw new Error(
      `TestRuntime.advance ran ${maxIterations} tasks without reaching ${target} ms; ` +
        "the loop under test is rescheduling without making progress",
    );
  }

  /**
   * Run exactly one scheduled task, whatever it reschedules.
   *
   * `advance` is the wrong tool for testing a single slice of an *unpaced*
   * loop: MAX reschedules with zero delay, so every iteration is immediately
   * due again and advancing to a fixed time never terminates. This runs one
   * iteration and stops, which is what a per-slice assertion needs.
   */
  runNext(): boolean {
    const next = this.#earliestDueBy(Number.POSITIVE_INFINITY);
    if (next === null) {
      return false;
    }
    this.#tasks = this.#tasks.filter((task) => task.id !== next.id);
    this.nowMs = Math.max(this.nowMs, next.at);
    next.callback();
    return true;
  }

  #earliestDueBy(target: number): ScheduledTask | null {
    let best: ScheduledTask | null = null;
    for (const task of this.#tasks) {
      if (
        task.at <= target &&
        (best === null || task.at < best.at || (task.at === best.at && task.id < best.id))
      ) {
        best = task;
      }
    }
    return best;
  }

  /** Most recent message of a type, or undefined. */
  last<T extends WorkerToMainType>(type: T): Extract<WorkerToMainMessage, { type: T }> | undefined {
    for (let i = this.posted.length - 1; i >= 0; i -= 1) {
      const message = this.posted[i] as WorkerToMainMessage;
      if (message.type === type) {
        return message as Extract<WorkerToMainMessage, { type: T }>;
      }
    }
    return undefined;
  }

  /** Every message of a type, in order. */
  all<T extends WorkerToMainType>(type: T): Extract<WorkerToMainMessage, { type: T }>[] {
    return this.posted.filter(
      (message): message is Extract<WorkerToMainMessage, { type: T }> => message.type === type,
    );
  }

  clearPosted(): void {
    this.posted.length = 0;
    this.postCounts.clear();
  }
}

/**
 * A small but genuinely generated world.
 *
 * 64² rather than the default 256²: these tests are about scheduling and
 * transport, and a sixteenth of the cells costs a sixteenth of the world
 * generation and a fraction of the per-tick work. The validity thresholds are
 * absolute totals calibrated for the default world, so they are scaled with the
 * area — otherwise a perfectly good small world is rejected for being small.
 */
export function createTestConfig(gridSize = 64): SimulationConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.envGridSize = gridSize;
  config.world.sizeLU = gridSize * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(gridSize / 8));
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 2,
  );
  const areaRatio = (gridSize * gridSize) / (256 * 256);
  config.world.validity.minFounderRegionCells = Math.max(
    16,
    Math.floor(config.world.validity.minFounderRegionCells * areaRatio),
  );
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity * areaRatio,
  );
  return config;
}

/** Seed of the project's mandatory deterministic fixture (CLAUDE.md). */
export const TEST_SEED = 0xe0a12026;

/** Build a well-formed main→worker message without going through the client. */
export function message(
  type: MainToWorkerMessage["type"],
  payload: unknown,
  requestId?: number,
): unknown {
  return requestId === undefined
    ? { protocolVersion: PROTOCOL_VERSION, type, payload }
    : { protocolVersion: PROTOCOL_VERSION, requestId, type, payload };
}
