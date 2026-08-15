# ADR 0017 — Milestone 10 review: persistence

Status: accepted · Date: 2026-08-15 · Engine 0.7.0 (unchanged) · Protocol 6 (unchanged) · Review of tasks K01–K06

Independent release-critical review of the Milestone 10 line (`20409e8` and its follow-ups): the
durable snapshot container, the generic value codec and its shape contract, the IndexedDB world
store, the protocol 6 save/load path, and the app-shell persistence controller.

**No P0 defects. Four P2s found and fixed**, none of which can move a world hash: `ENGINE_VERSION`,
`SNAPSHOT_SCHEMA_VERSION`, `CONFIG_SCHEMA_VERSION` and `PROTOCOL_VERSION` are all unchanged, and
every golden hash is reproduced.

## 0. Method

ADR 0016 and A18's report were treated as claims. The completeness audit was re-derived from the
_store classes_ rather than from the shape table that is supposed to describe them: every instance
field of `OrganismStore`, `GenomeStore`, `CarcassStore`, `SpeciesStore`, `EventStore`,
`EventDetectors`, `StatisticsStore`, `CommandLog` and `EnvironmentStore` was listed from source and
matched against capture, restore and hash. The acceptance run was written from the mandate rather
than adapted from the shipped one, because a review that reuses the implementation's harness
inherits its blind spots.

## 1. Snapshot completeness: verdict per field

Every future-affecting field is captured, restored and (where it may differ between two worlds)
hashed. Derived state is either recomputed at a fixed point in the tick order or, better, not
cached at all.

| Field                                                                              | Captured | Restored | Notes                                                                                          |
| ---------------------------------------------------------------------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------- |
| seed, tick, `generationAttempt`                                                    | ✓        | ✓        | tick as two 32-bit words in the header, safe-integer in the payload                            |
| PRNG state (4 words)                                                               | ✓        | ✓        | detached copy; saving draws nothing                                                            |
| config                                                                             | ✓        | ✓        | re-validated on restore; digest re-checked against the header                                  |
| environment arrays, `globalTemperatureOffsetCentiC`, founder region                | ✓        | ✓        | hashed since M9                                                                                |
| plant biomass, capacity, growth remainder                                          | ✓        | ✓        | remainder is what stops sparse cells freezing                                                  |
| organism SoA (23 per-slot arrays)                                                  | ✓        | ✓        | full slot prefix                                                                               |
| genomes, brain weights                                                             | ✓        | ✓        | phenotype cache recomputed from them                                                           |
| entity allocator (`nextEntityId`)                                                  | ✓        | ✓        | range-checked; live IDs must be below it                                                       |
| free lists (organisms, carcasses)                                                  | ✓        | ✓        | verbatim, not rebuilt; `#liveCount` and the entity→slot index are recomputed and cross-checked |
| carcasses + their counters                                                         | ✓        | ✓        |                                                                                                |
| cooldowns (attack, reproduction), water ticks, damage memory                       | ✓        | ✓        |                                                                                                |
| reproduction counters (`totalBirths`, `capRejectedBirths`, `birthEnergyDiscarded`) | ✓        | ✓        |                                                                                                |
| species registry, `#activeCount`                                                   | ✓        | ✓        | count recomputed from records                                                                  |
| species allocator (`nextSpeciesId`)                                                | ✓        | ✓        | record count must equal `nextSpeciesId - 1`                                                    |
| pending speciation (candidate passes + both centroids)                             | ✓        | ✓        | a zero-pass candidate is unrepresentable and asserted at capture                               |
| statistics (tiers + per-species ring series)                                       | ✓        | ✓        | deliberately unhashed — see §5                                                                 |
| event log, `nextEventId`, `droppedEventCount`                                      | ✓        | ✓        |                                                                                                |
| event detectors (5 counters, 3 rings, 3 latches)                                   | ✓        | ✓        | ring index is derived from `sampleCount`                                                       |
| command log, identity counters, cursor                                             | ✓        | ✓        | cursor cross-checked against the restored tick                                                 |

Not persisted, and correctly so: spatial grids and the carcass index (cleared on restore, rebuilt
in phase 2 before any consumer), the phenotype cache (recomputed from genomes), scratch buffers
(written before read within a tick), passability (a pure function of the stored biome), and the
plant gradient — which is no longer cached anywhere but computed where it is consumed.

## 2. The gap the shipped tests could not see (fixed by adding a test)

Every save tick in the shipped suite — 2 500, 4 000, 1 500, 800, 300×N, 200, 100 — is a multiple of
`time.environmentInterval` (20). The first tick after each of those loads therefore runs phase 1,
which would overwrite any environment-derived cache that a restore had rebuilt differently, before
anything could read it. The suite could not have caught a reintroduced gradient cache.

`reviewAcceptance.test.ts` adds a save at tick **2 503** — a multiple of none of the four scheduled
intervals — and continues it against an uninterrupted reference. It passes, which pins the property
that made it safe (gradient computed at its consumer, passability derived from biome) rather than
trusting it.

## 3. Fixed (P2): the manifest kept advertising a save nobody could read

A load whose newest save fails validation falls back to an older one — correctly, and without
deleting anything. But the manifest still pointed at the damaged save, and its status stayed `ok`.
The world list therefore kept showing that save's tick and state hash while Load silently delivered
an older world, and nothing in the UI said a save had gone bad.

`WorldStore.load` now repoints the manifest at the save that actually opened, with status `corrupt`
(or `legacy` for an engine mismatch) and a detail naming the tick that failed. The damaged rows are
still kept (docs/06 §27); only the pointer moves. A later healthy save clears the warning, which is
pinned by its own test. The repoint is queued like every other write and refuses to run if a newer
save landed while the load was reading. (`WorldStore.ts`)

## 4. Fixed (P2): `load` ignored the manifest and took the highest tick

Candidates were ordered newest-tick-first, so "Load" did not mean "the save this world is on" — it
meant "the save with the largest tick number". Those agree only because every save today advances
the clock; they stop agreeing the moment a world is restored from an older save and saved again,
which is exactly what Milestone 11's rewind and branch do. The manifest's `latestSnapshotId` is now
tried first and the rest follow as fallbacks. (`WorldStore.ts`)

## 5. Fixed (P2): a manual save could be silently swallowed by an autosave

`WorldPersistence.save` dropped any save that arrived while another was in flight, on the reasoning
that "the later tick is about to come around again anyway". That reasoning holds for an autosave and
fails for a click: a manual save is an explicit act, it carries the world's name, and the UI had
already acknowledged it. A click landing in the same frame as an autosave lost both the save and
the rename with nothing reported.

Autosaves still skip when busy. A manual save now waits for the in-flight operation and then takes
its turn. (`WorldPersistence.ts`)

## 6. Fixed (P2): a connection another tab closed stayed closed forever

`onversionchange` closed the connection — correct, it must not block another tab's upgrade — but the
store kept the dead handle, so every later call threw `InvalidStateError` for the rest of the
session. The handle is now dropped when the connection closes (`versionchange` or `close`), so the
next call reopens; and a `VersionError` on reopen is reported as a **version** problem naming the
real cause ("another tab upgraded this; reload the page") instead of "IndexedDB is unavailable".
(`db.ts`, `WorldStore.ts`)

## 7. Audited and found sound

- **Checksums.** CRC-32 over the payload and a second over the header, verified in that order; a
  payload edit is caught with the header still valid, which is what makes cheap listing safe.
- **Magic and versions.** Wrong magic, unknown container version, set reserved bits, foreign engine
  version and unsupported state schema are each refused with a distinct code, before any allocation
  sized by the payload. Header and payload identity (seed, tick, schema, engine) must agree.
- **The state hash in the header** is the strongest check in the format: it proves the restored
  _simulation state_ is the one that was saved, not merely that the bytes survived. Verified in the
  Worker before the running world is replaced.
- **Config digest.** Recomputed from the decoded config and compared. Sound because
  `canonicalJsonStringify` sorts keys, so the codec's canonical key order cannot change the digest.
- **Transactions and atomicity.** One `readwrite` transaction spans payload, metadata, retention and
  manifest; any failure — including one thrown by our own code — aborts the whole thing. An
  interrupted save leaves the previous save and manifest untouched and no orphan row.
- **Last-known-good.** Add before remove; manual saves never auto-pruned; a load never deletes.
- **Autosave races.** Serialized through one promise chain at the store, and now correctly
  prioritized at the controller (§5).
- **Deletion.** Manifest, metadata and payload rows go in one transaction; the panel asks twice.
- **Statistics are unhashed by design** (derived history nothing reads back), which means the hash
  comparisons cannot police their restore. Compared explicitly instead: a matured world's captured
  statistics must survive a round trip field for field.

## 8. Mandated acceptance

`reviewAcceptance.test.ts`, written from the mandate rather than adapted:

```text
CONTROL    fresh world + six interventions -> tick 10 000
SAVE/LOAD  same world+script -> tick 2 500 -> durable bytes -> runtime dropped
                             -> decode into a fresh engine -> tick 10 000
```

Identical canonical hashes. The world is non-trivial by assertion at tick 10 000: live population,
births, deaths, a non-empty organism free list, carcasses created, species records, timeline events,
statistics samples, and all six interventions applied — with the meteor aimed at the save tick
itself, so the snapshot carries applied history behind the cursor and a pending command ahead of it.
The off-lattice run of §2 is the second half of the gate.
