# ADR 0016 — Milestone 10: persistence

Status: accepted · Date: 2026-08-14 · Engine 0.7.0 unchanged · Protocol 5 → 6 · Tasks K01–K06

Milestone 10 makes a world outlive its tab. It changes no authoritative behavior: `ENGINE_VERSION`,
`SNAPSHOT_SCHEMA_VERSION` and `CONFIG_SCHEMA_VERSION` are untouched and every golden hash is
unchanged, which is exactly what a persistence milestone should be able to say.

A save has to be a _durable container_ the browser stores, and loading it has to reproduce the
exact deterministic future the world would have had if nobody had ever pressed Save. Rewind, historical preview and branching (K07–K11) are
Milestone 11 and are deliberately absent.

## 1. What was already there, and what was missing

The engine has produced a complete in-memory snapshot since Milestone 9: `EngineCoreSnapshot`
carries tick, seed, config, PRNG state, environment arrays, organisms with genomes, brains and
free lists, carcasses, species with pending split candidates, statistics, the event log, the
detector state and the command log with its cursor. `SimulationEngine.fromSnapshot` is a single
validated restore door.

So this milestone did **not** need to invent state capture. What was missing was everything
around it: a byte format, a database, a wire path from the Worker to storage, a UI, and the
proof that the round trip is exact.

## 2. Three layers, deliberately separable

```text
  @eon/engine       state  <-> EngineCoreSnapshot        (already existed)
  @eon/persistence  snapshot <-> bytes, and bytes <-> IndexedDB
  apps/web          when to save, what to tell the user
```

Inside `@eon/persistence` the split matters as much as the package boundary: `durableSnapshot`,
`valueCodec`, `snapshotShape`, `binary` and `crc32` touch no storage API at all, which is what
lets the **Worker** encode a save (it has the engine) while the **main thread** writes it (it has
the UI and the error reporting). docs/06 §26 allows either side to own IndexedDB; splitting on
"who can report the failure to a human" is what decided it.

## 3. The container format

96-byte header, then one encoded payload:

```text
  magic "EONSNAP\0" · containerVersion · headerBytes · schemaVersion · engineVersion(16 ASCII)
  configHash(16) · stateHash(16) · seed · tickLo · tickHi · payloadBytes · payloadCRC
  flags · reserved · headerCRC
```

Four decisions worth recording:

- **Two versions, two jobs.** `containerVersion` versions the framing; `schemaVersion` versions
  the engine state inside it. They move independently — the framing could gain compression
  without the engine changing, and the engine changes its payload most milestones without the
  framing moving.
- **Two checksums.** The header is checksummed separately so listing worlds — which reads
  headers only — can detect a damaged header without reading, or trusting, megabytes behind it.
- **The state hash travels in the header.** A CRC proves the bytes survived. The canonical state
  hash proves the _simulation state_ survived: a world restored from the file must hash to what
  the writer recorded, or this build is not reading those bytes as the same world. That check
  runs on every load, in the Worker, before the world is adopted.
- **The tick is two words.** A uint32 tick would make states exactly 2³² ticks apart
  indistinguishable in the header, which is the flaw `hashState.ts` already fixed for hashing.

## 4. A generic value codec, not a field-by-field writer

The payload is written by a small self-describing codec (`valueCodec`): tagged numbers, strings,
booleans, arrays, plain objects and the eight typed-array kinds. `EngineCoreSnapshot` is already
constrained to exactly that grammar (docs/06 §21: "no class prototype serialization"), so the
codec covers it whole.

The alternative — a hand-written writer for ~150 fields across nine stores — was rejected for one
reason: its failure mode. Forgetting to add a newly added authoritative field to a hand-written
writer produces a save that loads _successfully_ and then diverges, which is the single worst bug
this project can ship. With capture and encode joined, whatever `serialize()` returns is what
lands in the file.

Two things keep "generic" from meaning "untyped":

- **`snapshotShape.ts`** declares the durable shape and validates a decoded payload against it
  before the engine sees it, rebuilding every object as a plain object with only declared fields.
  Without it, a payload missing `organisms.alive` would surface as a `TypeError` thrown from
  inside a restore routine that had already begun mutating a live store.
- **`snapshotShape.test.ts`** walks a real snapshot from a world that has lived, and fails if the
  engine produces a field the shape does not describe. That is the enforcement mechanism behind
  "audit everything that can affect the future": the next milestone to add authoritative state
  cannot quietly add it to the engine and forget the file format.

Encoding is canonical — object keys are sorted — so the same state always produces the same
bytes, and two saves of the same tick are comparable byte for byte.

## 5. Durability: one transaction, add before remove, a queue

A failed or interrupted save must leave the last known good save exactly as it was. Three
mechanisms, all in `WorldStore`:

1. **One transaction per save.** The payload row, the metadata row, the retention deletes and the
   manifest update are a single `readwrite` transaction. Any failure aborts the whole thing —
   including failures thrown by our own code, which is why `#saveNow` aborts explicitly in a
   `catch` rather than letting already-queued requests commit.
2. **Add before remove.** The new save is written before any old save is considered for pruning.
3. **A queue, not a race.** Autosave and a manual click are serialized through one promise chain,
   so two read-modify-write cycles of the same manifest cannot interleave.

Retention keeps the newest N autosaves (default 5) and **never** prunes a manual save. The save
the previous manifest pointed at _is_ a pruning candidate, because the pointer update and the
deletes commit together: there is no committed state in which a manifest names a row that is gone.

Loading never destroys. A save that fails validation is kept, the world is marked `corrupt` or
`legacy` with the reason, and older saves are tried in turn — the load reports which save actually
opened and how many it walked past.

## 6. Metadata and payload are separate rows

`snapshots` holds metadata; `snapshotBlobs` holds bytes, under the same key. Listing worlds is the
most frequent read there is, and a combined row would drag every save's multi-megabyte buffer
through a structured clone to display a tick number and a date. The two rows are written and
deleted in the same transaction, so they cannot drift apart.

The stores docs/06 §19 also anticipates (`commandChunks`, `events`, `stats`, `preferences`) were
**not** created empty. A save currently carries its command log, event log and statistics inside
the payload, so those stores would be empty tables pretending to be a design. `MIGRATIONS` is an
ordered list precisely so adding them later is one appended function.

## 7. Protocol 6: REQUEST_SAVE, SNAPSHOT_DATA, LOAD_WORLD

`REQUEST_SAVE` asks the Worker for _bytes_ — it does not ask it to store anything — and
`SNAPSHOT_DATA` transfers them back. `LOAD_WORLD` hands stored bytes to the Worker, which decodes
them, restores an engine and verifies the state hash **before** touching the world it is already
running. A corrupt or foreign-engine save is therefore a non-fatal error: the running world keeps
running and the UI explains why the load was refused. `#adoptEngine` is shared by INIT and LOAD so
a restored world is hosted by exactly the same code path as a fresh one.

Saving reads authoritative state and nothing else. It draws no randomness, steps nothing and
mutates nothing — proven directly (`durableSnapshot.test.ts`: hash and PRNG state unchanged across
repeated saves, and a saved-then-continued engine matching one that was never saved).

## 8. Autosave is armed, not automatic

A new world is unbound: it has no database row, and autosave does nothing. Pressing Save, or
loading a stored world, binds the session; only then does autosave run, every
`autosaveCheckInterval` ticks (2 000, a _host_ setting — changing it cannot change a world hash).
Opening the page must not quietly fill a user's storage with worlds they never asked to keep.

The corollary matters as much: a brand-new world does **not** inherit the previous world's
identity, so pressing Save after generating a new world cannot overwrite the world you had open.

## 9. Acceptance: 10 000 ticks, two save points, one control run

The mandated test (docs/06 §25) is `acceptance.continuation.test.ts`: a control run to tick
10 000, against the same world saved at tick 2 500, encoded to bytes, dropped, decoded into a new
engine and continued to 10 000. Identical canonical hashes.

Two deviations from the literal reading, both deliberate and both documented in `testWorlds.ts`:

- **The world is 96×96 with 64 founders, not the 256² reference world.** The reference world
  costs ~10 minutes _per run_ at this horizon and the test needs two runs; `soak.test.ts` hit the
  same wall in Milestone 4 and answered it the same way. Every organism, brain, mutation,
  reproduction, combat and plant constant is `DEFAULT_CONFIG`'s. The reference world is still
  covered, by a shorter continuation in `continuation.test.ts` and by the engine's own
  10 000-tick golden fixture. A 64² variant was measured and rejected: it goes extinct near tick
  8 000, after which the comparison would be two empty worlds agreeing.
- **A second save point at tick 4 000, continued to 6 000**, taken from the same control run.
  Tick 2 500 is early enough that carcasses are barely present; by tick 4 000 this world has a
  thousand carcasses and a heavily recycled organism free list — the state a snapshot that
  rebuilds its free lists instead of storing them gets wrong. Reusing the control run costs 2 000
  extra ticks instead of another 6 000.

A guard test asserts the saved world is worth comparing: live organisms, births, deaths,
carcasses, a non-empty free list, mutated genomes, events and statistics all present at the save
tick. Without it the acceptance test could pass while proving almost nothing.

## 10. What is deliberately not here

- **Rewind, historical preview, branching** (K07–K11): Milestone 11.
- **Export/import `.eonworld` files** (docs/06 §32): later, and it is where untrusted-input
  hardening will matter most — the shape validator and the forbidden-key handling in the decoder
  were written with that future in mind.
- **Quota policy beyond retention** (docs/06 §31): sparse older checkpoints and bookmark pinning
  wait until there is a rewind feature that needs checkpoints.
- **Storing a snapshot per intervention.** Commands live inside the snapshot; chunking them into
  their own store belongs with replay.
