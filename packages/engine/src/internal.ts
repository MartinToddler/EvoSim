import { EonAssertionError } from "@eon/shared";
import type { EngineContext } from "./EngineContext";
import type { Xoshiro128 } from "./random/Xoshiro128";
import type { SimulationEngine } from "./SimulationEngine";

/**
 * Package-internal access to authoritative engine internals.
 *
 * WHY THIS EXISTS
 *
 * The PRNG must never be reachable from outside the engine: if application,
 * worker, renderer or test code could call `engine.rng.nextU32()`, authoritative
 * state would stop being a pure function of seed + config + commands + engine
 * version — the single most important contract in CLAUDE.md. So the engine
 * exposes no public PRNG handle at all.
 *
 * Engine phase functions from Milestone 2 onward (senseAll, integrateMovement,
 * resolveReproduction, … per docs/10 §3) live in sibling modules of this package
 * and legitimately need the PRNG. They get it here.
 *
 * The boundary is enforced by the package manifest, not by convention:
 * `@eon/engine` exports only `.` -> `src/index.ts`, and this module is
 * deliberately NOT re-exported from that entry point, so no consumer of the
 * package can import it. Internals are held in a WeakMap rather than on the
 * instance, so they are not reachable by property access or enumeration either.
 */
export interface EngineInternals {
  /** The authoritative PRNG. Advancing it outside a tick phase corrupts determinism. */
  readonly rng: Xoshiro128;
  /**
   * Everything a tick phase may touch, including the derived spatial index,
   * the phenotype cache and the scratch buffers.
   *
   * Phases receive this context rather than the engine, so the hot path never
   * performs a WeakMap lookup and each phase is unit-testable against a
   * synthetic context.
   */
  readonly context: EngineContext;
}

const INTERNALS = new WeakMap<SimulationEngine, EngineInternals>();

/** Called once by the SimulationEngine constructor. */
export function attachEngineInternals(engine: SimulationEngine, internals: EngineInternals): void {
  if (INTERNALS.has(engine)) {
    throw new EonAssertionError("engine internals attached twice");
  }
  INTERNALS.set(engine, internals);
}

/** Package-internal accessor for engine phase code and engine tests. */
export function engineInternals(engine: SimulationEngine): EngineInternals {
  const internals = INTERNALS.get(engine);
  if (internals === undefined) {
    throw new EonAssertionError("engine internals are not attached to this object");
  }
  return internals;
}
