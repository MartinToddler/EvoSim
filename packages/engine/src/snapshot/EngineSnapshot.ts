import type { SimulationConfig } from "../config/SimulationConfig";
import type { OrganismSnapshot } from "../organisms/organismSnapshot";
import type { Xoshiro128State } from "../random/Xoshiro128";
import type { EnvironmentSnapshot } from "../world/environmentSnapshot";

/**
 * Core engine snapshot (docs/10 §18).
 *
 * Captures everything needed to continue the engine exactly: tick, seed, full
 * PRNG state, config, the authoritative environment arrays and the live
 * organism population with its genomes and slot bookkeeping. Later milestones
 * extend this with carcasses, species, the command cursor and the remaining
 * statistics accumulators — each extension bumps SNAPSHOT_SCHEMA_VERSION.
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
   * Authoritative environment arrays. Not recomputable from the seed once the
   * world has grown, been grazed or been edited, so it must be stored.
   */
  environment: EnvironmentSnapshot;
  /**
   * Live organisms, their genomes and the slot/free-list state. The free list
   * must be stored verbatim: rebuilding it would change which slot the next
   * birth lands in, and with it every future state (docs/10 §18).
   */
  organisms: OrganismSnapshot;
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
