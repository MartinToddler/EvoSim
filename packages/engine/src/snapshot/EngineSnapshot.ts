import type { SimulationConfig } from "../config/SimulationConfig";
import type { Xoshiro128State } from "../random/Xoshiro128";

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
 */
export interface EngineCoreSnapshot {
  schemaVersion: number;
  engineVersion: string;
  seed: number;
  tick: number;
  rngState: Xoshiro128State;
  config: SimulationConfig;
}
