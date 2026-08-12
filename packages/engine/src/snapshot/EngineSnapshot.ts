import type { SimulationConfig } from "../config/SimulationConfig";
import type { Xoshiro128State } from "../random/Xoshiro128";
import type { EnvironmentSnapshot } from "../world/environmentSnapshot";

/**
 * Core engine snapshot v1 (Milestone 1 subset of docs/10 §18).
 *
 * Captures everything needed to continue the Milestone 1 engine exactly:
 * tick, seed, full PRNG state and config. Later milestones extend this with
 * environment arrays, organism/genome stores, carcasses, species, command
 * cursor and statistics accumulators — each extension bumps
 * SNAPSHOT_SCHEMA_VERSION.
 *
 * This is the abstract in-memory serialization primitive (plain JSON-safe
 * data). The durable binary container with header magic and payload checksum
 * (docs/06 §21) belongs to the persistence milestone (K03).
 *
 * `tick` is a JS safe integer, not a uint32 (see hashState.ts).
 */
export interface EngineCoreSnapshot {
  schemaVersion: number;
  engineVersion: string;
  seed: number;
  tick: number;
  rngState: Xoshiro128State;
  config: SimulationConfig;
  /**
   * Which generation attempt produced this world (0 = the seed worked
   * directly). Provenance, not simulation state: no authoritative rule reads
   * it and it is not hashed, but restoring no longer regenerates the world, so
   * without it the value would be lost across a save/load cycle.
   */
  generationAttempt: number;
  /**
   * Authoritative environment arrays plus the founder region. Not recomputable
   * from the seed once the world has grown, been grazed or been edited, so it
   * must be stored — and is now honoured on restore rather than regenerated.
   */
  environment: EnvironmentSnapshot;
}

/**
 * Error thrown when a snapshot cannot be safely restored.
 *
 * Lives here rather than in deserialize.ts so that the single validated
 * restore path (SimulationEngine.fromSnapshot) can raise it without importing
 * a module that imports the engine back.
 */
export class SnapshotCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotCompatibilityError";
  }
}
