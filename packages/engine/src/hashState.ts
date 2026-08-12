import { StateHash } from "./math/hash";
import type { SimulationEngine } from "./SimulationEngine";

/**
 * Canonical authoritative state hash (task B06).
 *
 * The word sequence below IS the canonical hashing contract for the current
 * engine version and is locked by golden fixture tests (task B08). Extending
 * the sequence in later milestones (environment arrays, organism stores, …)
 * changes hashes and therefore requires an ENGINE_VERSION bump, regenerated
 * goldens and a changelog entry (CLAUDE.md).
 *
 * Canonical sequence (engine 0.1.1):
 *   1. magic word 0x454f4e48 ("EONH")
 *   2. tick as TWO words: low 32 bits, then high bits
 *   3. seed
 *   4. PRNG state words s0..s3
 *   5. authoritative config digest (two hex halves as words)
 *
 * The tick is hashed as a safe integer rather than a single word because a
 * uint32 tick would make states exactly 2^32 ticks apart hash identically
 * (engine 0.1.0 had this flaw).
 *
 * The config digest covers the authoritative SimulationConfig only. Host/runtime
 * pacing values (render cadence, worker slice budget, …) live in a separate
 * HostRuntimeConfig precisely so that changing them cannot alter world hashes.
 *
 * ENGINE_VERSION itself is deliberately NOT part of the stream: hashes change
 * exactly when behavior/state changes, and the fixture file pins which engine
 * version its hashes belong to.
 */
export const STATE_HASH_MAGIC = 0x454f4e48;

export function computeStateHash(engine: SimulationEngine): string {
  const hasher = new StateHash();
  hasher.word(STATE_HASH_MAGIC);
  hasher.safeInteger(engine.tick);
  hasher.word(engine.seed);

  const rng = engine.getRngState();
  hasher.word(rng[0]);
  hasher.word(rng[1]);
  hasher.word(rng[2]);
  hasher.word(rng[3]);

  // Config digest is 16 hex chars == two uint32 words.
  const configHash = engine.configHash;
  hasher.word(parseInt(configHash.slice(0, 8), 16));
  hasher.word(parseInt(configHash.slice(8, 16), 16));

  return hasher.digest();
}
