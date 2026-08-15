import { StateHash } from "../math/hash";
import type { EnvironmentStore } from "./EnvironmentStore";

/**
 * Magic word separating the environment-only digest from the canonical world
 * state hash, so the two can never be confused for one another.
 */
export const ENVIRONMENT_HASH_MAGIC = 0x454f4e45; // "EONE"

/**
 * Digest of the authoritative environment arrays alone.
 *
 * This is a DIAGNOSTIC digest, not the canonical world state hash: it covers
 * only what {@link EnvironmentStore.hashInto} feeds, and deliberately excludes
 * the tick, seed, PRNG state and config digest. Use it to answer "is this the
 * same map?" independently of "is this the same world history?" — which is
 * exactly the question a world-generation debug view asks.
 *
 * It reuses the same array order as the canonical hash, so it is covered by the
 * same contract: changing that order changes both digests and requires an
 * ENGINE_VERSION bump. Reading it never mutates engine state.
 */
export function hashEnvironment(environment: EnvironmentStore): string {
  const hasher = new StateHash();
  hasher.word(ENVIRONMENT_HASH_MAGIC);
  environment.hashInto(hasher);
  return hasher.digest();
}
