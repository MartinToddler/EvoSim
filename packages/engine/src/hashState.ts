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
 * Canonical sequence (engine 0.7.0):
 *   1. magic word 0x454f4e48 ("EONH")
 *   2. tick as TWO words: low 32 bits, then high bits
 *   3. seed
 *   4. PRNG state words s0..s3
 *   5. authoritative config digest (two hex halves as words)
 *   6. environment arrays (see EnvironmentStore.hashInto)
 *   7. founder region as four words (foundation-gate ADR §3: it decides where
 *      founders spawn, and on restore the SAVED region is the truth, so two
 *      states differing only here must hash differently)
 *   8. organism slot state and per-slot arrays (OrganismStore.hashInto)
 *   9. genomes and brain weights for the used slot prefix (GenomeStore.hashInto)
 *  10. carcass slot state and per-slot arrays (CarcassStore.hashInto)
 *  11. species registry and split-candidate state (SpeciesStore.hashInto)
 *  12. world event log (EventStore.hashInto)
 *  13. event-detector state (EventDetectors.hashInto)
 *  14. player command log with identity counters and cursor (CommandLog.hashInto)
 *
 * Derived state is deliberately absent: the spatial index, the phenotype cache,
 * the trait normalization table and every scratch buffer are pure functions of
 * what is hashed above, and are rebuilt at fixed points in the tick order. The
 * statistics time series is also absent, and for a different reason: it is
 * derived HISTORY — a pure record of past authoritative states that nothing
 * ever reads back into simulation or event detection — and its retention shape
 * is presentation capacity, which must never move a world hash. It is
 * serialized, and a round-trip test pins that serialization exactly.
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

  engine.environment.hashInto(hasher);

  const region = engine.founderRegion;
  hasher.word(region.centerCellIndex);
  hasher.word(region.centerGridX);
  hasher.word(region.centerGridY);
  hasher.word(region.componentCells);

  engine.organisms.hashInto(hasher);
  engine.genomes.hashInto(hasher, engine.organisms.slotHighWater);
  engine.carcasses.hashInto(hasher);
  engine.species.hashInto(hasher);
  engine.events.hashInto(hasher);
  engine.detectors.hashInto(hasher);
  engine.commands.hashInto(hasher);

  return hasher.digest();
}
