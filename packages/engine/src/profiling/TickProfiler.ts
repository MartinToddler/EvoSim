/**
 * Tick phase profiling hooks (CLAUDE.md "Profiling").
 *
 * ## Why the engine cannot time itself
 *
 * CLAUDE.md requires per-phase instrumentation from the first vertical slice,
 * and in the same document forbids the engine from calling `performance.now()`
 * or `Date.now()`. Both rules are right, and they are not in conflict: the
 * engine knows *where* the phase boundaries are, and the host knows *what time
 * it is*. So the engine calls out at each boundary and the host decides what
 * that means.
 *
 * A profiler therefore cannot affect determinism even in principle. It receives
 * two integers and returns nothing; there is no channel through which a clock
 * reading could reach authoritative state. Running with and without a profiler
 * attached produces identical state hashes, and a test asserts exactly that.
 *
 * ## Cost when nothing is attached
 *
 * One `undefined` check per phase boundary, roughly two dozen per tick, against
 * a tick that touches thousands of organisms. Measured cost is not
 * distinguishable from noise, so there is no "profiling build".
 */

/**
 * Phases reported to a profiler.
 *
 * This is CLAUDE.md's required list mapped onto the authoritative phase order
 * in `SimulationEngine.step`. Several engine phases are deliberately collapsed
 * into one profiling phase — `buildFeedingClaims` and `resolveFeedingClaims`
 * are one cost centre to anyone reading a profile, and splitting them would
 * report detail nobody optimizes against.
 */
export const TickPhase = {
  /** The whole tick, including every phase below. */
  Total: 0,
  Environment: 1,
  /** Both organism spatial indexes plus the carcass index. */
  SpatialRebuild: 2,
  Sensing: 3,
  Brain: 4,
  /** Integration plus terrain and soft-collision resolution. */
  Movement: 5,
  Feeding: 6,
  Combat: 7,
  /** Metabolism, growth, thermal stress, aging and death finalization. */
  MetabolismDeath: 8,
  Reproduction: 9,
  /** Scheduled carcass decay. */
  Carcasses: 10,
  /** Reserved for Milestone 8 species analysis. */
  SpeciesAnalysis: 11,
  /** Render snapshot production. Measured by the host, outside `step()`. */
  RenderSnapshot: 12,
} as const;

export type TickPhaseId = (typeof TickPhase)[keyof typeof TickPhase];

export const TICK_PHASE_COUNT = 13;

export const TICK_PHASE_NAMES: readonly string[] = [
  "total",
  "environment",
  "spatialRebuild",
  "sensing",
  "brain",
  "movement",
  "feeding",
  "combat",
  "metabolismDeath",
  "reproduction",
  "carcasses",
  "speciesAnalysis",
  "renderSnapshot",
];

/**
 * Phase boundary sink.
 *
 * Implementations must be non-throwing and side-effect free with respect to the
 * simulation. A profiler that threw would abort a tick halfway through and
 * corrupt state, so hosts are expected to swallow their own failures.
 */
export interface TickProfiler {
  begin(phase: TickPhaseId): void;
  end(phase: TickPhaseId): void;
}
