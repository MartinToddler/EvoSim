import { SimulationEngine } from "../SimulationEngine";
import type { EngineCoreSnapshot } from "./EngineSnapshot";

export { SnapshotCompatibilityError } from "./EngineSnapshot";

/**
 * Restore an engine from a core snapshot.
 *
 * Thin alias for {@link SimulationEngine.fromSnapshot}, which owns the single
 * validated restore path (version/schema compatibility, config validation and
 * tick range are all checked there). There is deliberately no second door that
 * could set tick or PRNG state without those checks.
 */
export function engineFromSnapshot(snapshot: EngineCoreSnapshot): SimulationEngine {
  return SimulationEngine.fromSnapshot(snapshot);
}
