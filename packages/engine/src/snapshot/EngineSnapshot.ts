import type { CommandLogSnapshot } from "../commands/CommandLog";
import type { SimulationConfig } from "../config/SimulationConfig";
import type { CarcassSnapshot } from "../ecology/carcassSnapshot";
import type { SpeciesSnapshot } from "../evolution/SpeciesStore";
import type { EventStoreSnapshot } from "../history/EventStore";
import type { EventDetectorsSnapshot } from "../history/eventDetection";
import type { StatisticsSnapshot } from "../history/StatisticsStore";
import type { OrganismSnapshot } from "../organisms/organismSnapshot";
import type { Xoshiro128State } from "../random/Xoshiro128";
import type { EnvironmentSnapshot } from "../world/environmentSnapshot";

/**
 * Core engine snapshot (docs/10 §18).
 *
 * Captures everything needed to continue the engine exactly: tick, seed, full
 * PRNG state, config, the authoritative environment arrays and the live
 * organism population with its genomes and slot bookkeeping, and the carcasses
 * lying in the world. Later milestones extend this with species, the command
 * cursor and the remaining statistics accumulators — each extension bumps
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
  /**
   * Which generation attempt produced this world (provenance, not hashed).
   * Stored so restore never re-runs generation to rediscover it
   * (foundation-gate ADR §2).
   */
  generationAttempt: number;
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
  /**
   * Carrion, with its own slot/free-list state. Carcasses are food that
   * organisms can already see and claim, so losing them on reload would change
   * what the next tick does, and rebuilding their free list would change which
   * slot the next death reuses (docs/10 §18).
   */
  carcasses: CarcassSnapshot;
  /**
   * The species registry with its split-candidate state (docs/10 §18). A world
   * restored without it would re-run its pending splits from zero and speciate
   * on different ticks than the world that never saved.
   */
  species: SpeciesSnapshot;
  /**
   * The timeline: event log, the detector state that decides FUTURE events
   * (docs/02 §9), and the derived statistics series that back the charts.
   */
  history: {
    events: EventStoreSnapshot;
    detectors: EventDetectorsSnapshot;
    stats: StatisticsSnapshot;
  };
  /**
   * The player command log with its application cursor (task J01). The cursor
   * is what makes a restored world apply each command exactly once: applied
   * history stays behind it, pending commands ahead of it. Losing the log
   * would lose replay; losing the cursor would double-apply on resume.
   */
  commands: CommandLogSnapshot;
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
