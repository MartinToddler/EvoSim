import { SimulationHost, type HostTimerHandle } from "./SimulationHost";
import type { WorkerToMainMessage } from "@eon/protocol";

/**
 * Simulation Worker entry point (docs/02 §3, docs/10 §20).
 *
 * Deliberately the thinnest file in the project. It supplies the three pieces
 * of browser that a host genuinely needs — a clock, a scheduler and a port —
 * and hands them to {@link SimulationHost}, which contains all the scheduling
 * logic and is therefore testable in Node. There are no simulation rules here,
 * and there is no state: everything below is wiring.
 */

/**
 * Minimal view of `DedicatedWorkerGlobalScope`.
 *
 * The app's tsconfig loads the DOM lib, in which `self` is a `Window` whose
 * `postMessage` takes a target origin. Pulling in the `webworker` lib instead
 * would fix `self` and break every DOM type the renderer needs, so the two
 * members this file actually uses are declared locally.
 */
interface DedicatedWorkerScope {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const scope = globalThis as unknown as DedicatedWorkerScope;

const host = new SimulationHost({
  clock: {
    now: (): number => performance.now(),
  },
  scheduler: {
    schedule: (callback: () => void, delayMs: number): HostTimerHandle =>
      setTimeout(callback, delayMs),
    cancel: (handle: HostTimerHandle): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  },
  port: {
    post: (message: WorkerToMainMessage, transfer?: readonly ArrayBuffer[]): void => {
      if (transfer !== undefined && transfer.length > 0) {
        scope.postMessage(message, transfer as ArrayBuffer[]);
      } else {
        scope.postMessage(message);
      }
    },
  },
});

scope.onmessage = (event: { data: unknown }): void => {
  host.handleMessage(event.data);
};
