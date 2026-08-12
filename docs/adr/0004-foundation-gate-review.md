# ADR 0004 — Milestone 0–2 foundation gate: review findings and fixes

Status: accepted · Date: 2026-08-12 · Engine 0.2.0 → 0.2.1 · Snapshot schema 3 → 4

An independent review of Milestones 0, 1 and 2 against the determinism contract. Every claim in
ADR 0002 was re-verified against the code and the tests rather than taken on trust; the PRNG
encapsulation, the clone→validate→freeze→hash ordering and the 64-bit tick handling all hold as
described (§8 lists what was checked).

Six defects were found and fixed. Four are Milestone 2's — §§1, 2, 3 and 5 — and three of those
are the same class ADR 0002 exists to prevent: authoritative state that outside code can reach,
or that the state hash does not cover. Two predate it and survived ADR 0002's own pass: §4
(unknown config fields entering the world hash) and §6 (unbounded world geometry) are both gaps
in what ADR 0002 §6 called "complete" configuration validation.

No organism code was written. This ADR fixes the foundation; Milestone 3 is untouched.

## 1. The environment was published as a writable store

`SimulationEngine.environment` was a public `EnvironmentStore` with live TypedArrays and a
public `globalTemperatureOffsetCentiC`. A probe of the shipped code confirmed the consequence:

```ts
engine.environment.plantBiomass[0] = 12345; // outside any tick
engine.computeStateHash(); // → different world
```

This is exactly the defect ADR 0002 §1 fixed for the PRNG, reopened one milestone later on a
larger surface. ADR 0002 §1 had in fact anticipated it — "the seed of the `EngineContext` that
Milestone 2 will need (stores, spatial grids, scratch buffers)" — and Milestone 2 put the store
on the public API instead.

Now:

- the live `EnvironmentStore` is an `EngineInternals` member, reachable only through
  `internal.ts`, which is not exported from the package;
- `engine.environment` returns a `ReadonlyEnvironmentView`: a **frozen projection object**,
  built once per store, holding the same array references. Reads cost what they cost on the
  store — no copy, no proxy trap, no per-access allocation — but `recomputePassability`,
  `hashInto` and `setGlobalTemperatureOffsetCentiC` are simply absent from it, so casting away
  the type finds nothing to call;
- `globalTemperatureOffsetCentiC` is a private field with a getter, so it survives the store
  being frozen while remaining unwritable from outside;
- `EnvironmentStore` itself is frozen, so an array reference cannot be swapped for a shorter or
  aliased buffer.

**Stated honestly, because the alternative is a false sense of safety:** element writes through
a cast (`(view.plantBiomass as Uint16Array)[0] = 1`) are still possible. `Object.freeze` throws
on a TypedArray that has elements, and a `Proxy` would put a trap on every read in the hottest
loops in the project. The boundary that actually holds is the type plus the existing lint rule
banning deep engine imports, plus the fact that the renderer and UI are specified to consume
snapshots (docs/02 §3), never the store.

`landFractionQ`, `labelLandComponents`, `totalPlantBiomass` and the other read-only helpers now
take `ReadonlyEnvironmentView`, so they work on either side of the boundary.

## 2. Restoring a snapshot regenerated the world and threw the result away

`fromSnapshot()` ran the full constructor — six noise fields, 24 dilation passes, a flood fill
and a box blur, ≈90 ms — and then overwrote every array from the snapshot. Two consequences, one
wasteful and one wrong:

- **The stored founder region was discarded.** A snapshot whose region was `cell 7` restored as
  `cell 40426`, silently, because the region came from the regenerated map. Today the two agree
  by construction; from Milestone 9 (terrain raise/lower, docs/03 §25) they will not, and the
  saved region is the true one.
- **A perfectly good save could become unloadable.** If the config's validity thresholds no
  longer admit any world for that seed, `createWorld` throws — on a payload that needs no
  generation at all.

`fromSnapshot()` now constructs through a module-private restore channel that skips generation
and adopts the payload. Restore dropped from ≈90 ms to ≈6 ms.

The channel is a second constructor argument guarded by a module-level `Symbol` that is never
exported, so it cannot be forged even by JavaScript callers who ignore the types — the "single
validated restore door" of ADR 0002 §2 stays single.

`generationAttempt` was previously recomputed by that regeneration, so skipping it would have
lost the value; it joins the snapshot payload. It is provenance, not state: no rule reads it and
it is not hashed.

## 3. The founder region is authoritative state and is now hashed

It decides where Milestone 3 spawns 256 organisms. Two states agreeing on every array but
disagreeing on the region are different worlds, and before this change they shared a hash —
hash-as-identity, the property every golden test and every save/restore assertion rests on, did
not hold for it.

It is hashed after the environment arrays as four words. This is the engine-version bump.

## 4. Unknown configuration fields silently entered the world hash

`hashConfig()` serializes whatever keys the object has, and `validateConfig()` only inspected
the fields it knew about. So:

```ts
config.targetTicksPerSecond1x = 20; // a host value, ADR 0002 §4 moved it out
new SimulationEngine({ seed, config }); // accepted — and a different world hash
```

The same hole swallowed typos: `time.enviromentInterval` would be ignored by every rule _and_
change world identity, which is the worst possible combination. A missing field was worse still
— `undefined` reaching a hot loop.

`validateConfig()` now requires the configuration to have exactly the shape of the schema.
`DEFAULT_CONFIG` is the template, because TypeScript already forces it to carry exactly the
fields of `SimulationConfig`, so the runtime check can never drift from the interface it guards.
Array _lengths_ stay free (the elevation octave stack is a calibration decision); element shape
and every object key set are fixed.

This is what makes ADR 0002 §4's authoritative/host split enforceable rather than merely
documented, and `hashedConfigSurface.test.ts` now also names the seven host-owned fields
explicitly so one coming back fails a test.

## 5. Snapshot loads validated lengths but not values

A payload with correct array lengths and impossible contents restored without complaint. Setting
every biome to 200 was accepted; the world then went barren on the next environment update,
because unknown biome indices fall through `?? 0` capacity lookups. No error anywhere.

`restoreEnvironment()` now checks the invariants docs/03 §27 states as world invariants: fields
within `[0, Q]`, biome indices inside the enum, carried growth strictly below one unit, biomass
never above its own cell's capacity, an integral global offset, and a founder region whose cell
index, coordinates and component size are consistent with the grid it claims to belong to. One
pass on load; nothing added to the per-tick path.

## 6. World geometry had no upper bound

`world.envGridSize` only had to be a positive safe integer, so a typo reached
`new Uint16Array()` and surfaced as a bare `RangeError: Invalid typed array length` naming no
config field. Two bounds added:

- `envGridSize ≤ 4096` (16.7 M cells) — an allocation ceiling, far above the 256 the MVP uses;
- `sizeLU ≤ floor((2³¹−1) / POS_SCALE)` = 8 388 607 — organism positions are `Int32Array`
  sub-units at 256 per LU (docs/03 §§3, 6), so a wider world would wrap coordinates rather than
  merely be large. Checked now, before Milestone 3 stores a single position.

## 7. Smaller findings

- **`deepCloneJson` and `__proto__`.** `JSON.parse` produces a real own `"__proto__"` key, and
  snapshots are JSON that may come from disk. Plain assignment invoked `Object.prototype`'s
  setter and reshaped the clone's prototype instead of copying data. It is now defined as an own
  property, so the data survives and §4's schema check rejects it as an unknown field. (No
  pollution of `Object.prototype` was possible either way; the clone itself was the target.)
- **Dead noise salts.** `NOISE_SALT.elevationOctave1/2` were never used — `layeredNoiseQ`
  derives per-octave salts itself — and suggested a mapping that does not exist. Removed;
  `elevationOctave0` became `elevation` and the stride is a named constant. No behaviour change.
- **A magic `4096`** in `EnvironmentStore.getMoistureQ` replaced by `Q`.

## 8. Verified and found correct

Recorded so a later review does not re-derive them:

- no `Math.random`, `Date.now`, `performance.now` or `new Date` anywhere in `packages/engine`
  (lint-enforced, and the rule was checked to actually fire);
- world generation makes **zero** PRNG draws, so the generator's state after construction is its
  seeded state whatever the map turned out to be;
- every authoritative loop iterates by ascending index; the only key-ordered walk is
  `canonicalJsonStringify`, which sorts;
- `StateHash.safeInteger` and `statelessNoiseU32` both carry the tick's high word, and
  `tick % interval` scheduling reads the whole tick — a test restores to 2³² (≡ 16 mod 20) and
  proves the environment phase does **not** run there, which a `>>> 0` scheduler would get wrong;
- config clone → validate → freeze → hash ordering, and the frozen engine instance, still hold;
- `getRngState()` returns a detached copy; the restore path is still the only door onto tick and
  PRNG state.

## 9. Versioning

| Constant                  | Change            | Reason                                                                               |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| `ENGINE_VERSION`          | 0.2.0 → **0.2.1** | The canonical hash stream gained the founder region (§3).                            |
| `SNAPSHOT_SCHEMA_VERSION` | 3 → **4**         | The payload gained `generationAttempt` (§2).                                         |
| `CONFIG_SCHEMA_VERSION`   | unchanged (3)     | No field was added, removed or renamed; §4 only enforces the shape already declared. |
| `PROTOCOL_VERSION`        | unchanged (1)     | No wire shape changed.                                                               |

All golden hashes regenerated, including the 100 000-tick soak hash. The world content itself is
byte-identical — the headless summary still reports the same land share, the same biome
distribution and founder cell 40426 — so only the hash stream moved, not the simulation.

## 10. Explicitly not done

- **No organisms.** Milestone 3 (D01–D13) is untouched, as instructed.
- **`main` was not advanced.** It exists at the Milestone 0/1 commit; this work is on
  `claude/evosim-project-setup-ps3fry`. Merging it and switching the repository's default branch
  are owner decisions (ADR 0002 §8 made the same note).
- **`plantCapacity` is still stored and hashed** although it is derivable from biome, fertility,
  moisture, temperature and config. docs/03 §14 lists it as an environment array, and hashing it
  is a free consistency check against the fields it is derived from. Recomputing it on load
  instead would be a behaviour change with no benefit.
- **The seed bank still runs in biomes whose growth rate is zero**, lifting them to
  `plantMinRegenThreshold`. This was examined and left alone: docs/03 §20 does not gate the seed
  bank on the growth rate, and `plantSeedBankRegenUnits = 0` is the correct switch for a true
  "no regrowth" ablation.
