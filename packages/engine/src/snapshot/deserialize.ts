import { SimulationEngine } from "../SimulationEngine";
import { validateConfig } from "../config/validateConfig";
import { ENGINE_VERSION, SNAPSHOT_SCHEMA_VERSION } from "../version";
import type { EngineCoreSnapshot } from "./EngineSnapshot";

/** Error thrown when a snapshot cannot be safely restored. */
export class SnapshotCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotCompatibilityError";
  }
}

/**
 * Restore an engine from a core snapshot (Milestone 1 acceptance:
 * serialize/resume must continue with exact hashes).
 *
 * Compatibility policy for MVP (docs/06 §28): schema version AND engine
 * version must match exactly. Replaying an old save under changed engine
 * semantics while pretending it is the same history is forbidden; callers
 * surface {@link SnapshotCompatibilityError} instead of silently migrating.
 */
export function engineFromSnapshot(snapshot: EngineCoreSnapshot): SimulationEngine {
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotCompatibilityError(
      `snapshot schema ${snapshot.schemaVersion} is not supported (expected ${SNAPSHOT_SCHEMA_VERSION})`,
    );
  }
  if (snapshot.engineVersion !== ENGINE_VERSION) {
    throw new SnapshotCompatibilityError(
      `snapshot was produced by engine ${snapshot.engineVersion}; this engine is ${ENGINE_VERSION} ` +
        "and MVP policy requires exact engine compatibility",
    );
  }
  validateConfig(snapshot.config);

  const engine = new SimulationEngine({ seed: snapshot.seed, config: snapshot.config });
  engine.restoreCore(snapshot.tick, snapshot.rngState);
  return engine;
}
