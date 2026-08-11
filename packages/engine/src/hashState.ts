import { StateHash } from "./math/hash";
import type { SimulationEngine } from "./SimulationEngine";

/**
 * Canonical authoritative state hash (task B06).
 *
 * The word sequence below IS the canonical hashing contract for engine v0.1
 * and is locked by golden fixture tests (task B08). Extending the sequence in
 * later milestones (environment arrays, organism stores, …) changes hashes
 * and therefore requires an ENGINE_VERSION bump, regenerated goldens and a
 * changelog entry (CLAUDE.md).
 *
 * Canonical sequence v0.1:
 *   1. magic word 0x454f4e48 ("EONH")
 *   2. tick
 *   3. seed
 *   4. PRNG state words s0..s3
 *   5. config digest (two hex halves as words)
 *
 * ENGINE_VERSION itself is deliberately NOT part of the stream: hashes change
 * exactly when behavior/state changes, and the fixture file pins which engine
 * version its hashes belong to.
 */
export const STATE_HASH_MAGIC = 0x454f4e48;

export function computeStateHash(engine: SimulationEngine): string {
  const hasher = new StateHash();
  hasher.word(STATE_HASH_MAGIC);
  hasher.word(engine.tick);
  hasher.word(engine.seed);

  const rng = engine.rng.serializeState();
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
