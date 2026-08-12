# ADR 0002 — Milestone 1 hardening: state encapsulation, config split, 64-bit ticks

Status: accepted · Date: 2026-08-12 · Supersedes parts of ADR 0001 · Engine 0.1.0 → 0.1.1

Review of Milestone 1 found that the determinism contract — _authoritative state follows only
from seed + config + commands + engine version_ — was not actually enforced by the code. This
ADR records how it is enforced now, and the judgement calls made along the way.

## 1. The PRNG is no longer reachable from outside the engine

`SimulationEngine` exposed `readonly rng: Xoshiro128`, so any caller (app, worker, renderer,
test) could advance the generator outside `step()` and outside the future command log. The
Milestone 1 tests even demonstrated the pattern.

Now:

- the generator lives in an ECMAScript private field `#rng`;
- the public API offers only `getRngState()`, which returns a detached copy for hashing,
  serialization and assertions;
- engine-internal phase code (Milestone 2+: `senseAll`, `integrateMovement`, …) reaches the
  live generator through `packages/engine/src/internal.ts`, which keys a module-level
  `WeakMap`. That module is deliberately absent from `src/index.ts`, and `@eon/engine` exports
  only `.`, so no consumer of the package can import it.

Rejected alternatives: keeping a TypeScript `private` field (compile-time only, defeated by a
cast); passing the generator to every phase as an extra parameter (all phase signatures grow
for the few phases that need randomness).

The `EngineInternals` object is the seed of the `EngineContext` that Milestone 2 will need
(stores, spatial grids, scratch buffers). Phase functions should then take the **context**, not
the engine, so the hot path never performs a WeakMap lookup and phases stay unit-testable
against a synthetic context.

A lint rule additionally forbids `apps/**` and non-engine packages from deep-importing engine
sources: the package `exports` map blocks `@eon/engine/src/internal`, but a relative path such
as `../../packages/engine/src/internal` would still resolve under Vite and `tsc`.

## 2. Restoration has exactly one validated door

`restoreCore(tick, rngState)` was public, so tick and PRNG state could be overwritten at will.
It is gone. `SimulationEngine.fromSnapshot()` is now the only path that can set them, and it
checks snapshot schema version, engine version (exact match, docs/06 §28), config validity and
tick range before constructing anything. `engineFromSnapshot()` is a thin delegation kept for
API stability.

## 3. Configuration is copied, validated, frozen, then hashed — in that order

A caller-supplied config was stored by reference, so mutating it after construction left
`configHash` describing a configuration the engine was no longer using. Two worlds could share
a config hash and behave differently.

The constructor now performs **clone → validate the clone → deep freeze → hash that same
object**. The order is deliberate: validating the caller's object and copying afterwards would
let a config with getters or a `Proxy` show one set of values to the validator and another to
the clone and the hash. A regression test covers exactly that.

`engine.config` is typed `DeepReadonly<SimulationConfig>`. Note honestly what the type does and
does not do: TypeScript ignores property `readonly` modifiers when checking assignability, so a
deeply readonly config still satisfies `SimulationConfig`. The type stops direct assignment and
documents intent; **the runtime deep freeze is the actual enforcement.**

`DeepReadonly` is defined as a homomorphic mapped type so tuple shapes survive — a naive
`ReadonlyArray<infer E>` branch would collapse the four-word PRNG state tuple into
`ReadonlyArray<number>`.

Seeds must now be integers. `seed >>> 0` silently maps `1.5` to `1` and `NaN` to `0`, so two
callers who believed they had used different seeds could have been handed the same world.

The engine instance itself is frozen at the end of construction. A probe of the finished code
found that `configHash` — `readonly` in TypeScript, an ordinary writable property at runtime —
could be reassigned from outside, changing a world's state hash without changing a single
simulation value. `Object.freeze(this)` closes that, and private fields (`#tick`, `#rng`) live in
internal slots that freezing does not touch, so the engine still advances its own state.

## 4. Authoritative configuration is separated from host runtime configuration

`hashConfig()` hashes the whole `SimulationConfig`, and that digest enters the authoritative
state hash. With wall-clock values inside the config, changing the render snapshot rate from
15 Hz to 20 Hz changed every world hash although no organism behaved differently.

`SimulationConfig` is now authoritative by construction. Everything that shapes _hosting_
moved to `HostRuntimeConfig` in `@eon/protocol` — the Worker host is its consumer, it travels
with `INIT_NEW_WORLD`/`LOAD_WORLD`, and the pure engine never sees it (docs/02 §3: the engine
"knows nothing about Workers, browser, Pixi, React, persistence or real time").

Moved to `HostRuntimeConfig`: `targetTicksPerSecond1x`, `normalRenderSnapshotsPerSecond`,
`maxModeRenderSnapshotsPerSecond`, `maxWorkerSliceMs`, `autosaveCheckInterval`,
`ticksPerSimYear`, `maxDetailedRenderedOrganisms`.

Two calls were genuinely contested; an independent analysis argued the opposite of what was
implemented, and the reasoning is recorded so the decision can be revisited cheaply:

- **`ticksPerSimYear` → host.** Counter-argument: it is denominated in ticks, and years are the
  natural hook for a future seasonal cycle. Decisive for host: it is a display divisor no
  authoritative rule reads, so keeping it authoritative would bake a non-behavioural value into
  every world hash — the exact defect this section fixes — and CLAUDE.md ranks engine/
  presentation separation immediately after determinism. If seasons ever land, the engine
  _cannot_ quietly read a non-hashed value: the field is in another package, so promoting it
  back into `SimulationConfig` (with a `CONFIG_SCHEMA_VERSION` bump) is a compile error away,
  not a silent divergence.
- **`limits.maxTimelineEventsInMemoryBeforeChunk` → authoritative.** Counter-argument: it is a
  persistence flush threshold. Decisive for authoritative: treating it as host-only is only
  sound under an unwritten invariant (event debounce must be computed from explicit counters,
  never by scanning the in-memory buffer). A hashed, engine-owned buffer bound needs no such
  invariant. `limits.recentDeadHistorySize` stays authoritative for the same reason.

`limits.maxOrganisms` and `limits.maxCarcasses` are authoritative without qualification: a cap
that changes outcomes when reached is a world input.

**Deviation from the written spec, stated plainly:** docs/08 §3 lists the five pacing fields
inside `TimeConfig` and docs/08 §4 lists `maxDetailedRenderedOrganisms` under limits. This ADR
moves them out. The section list of docs/02 §17 is unchanged — only the contents of `time` and
`limits` shrink — and docs/08 §3 already states that these values "never enter authoritative
calculations", so the move implements that sentence rather than contradicting it.

`species.analysisIntervalTicks` was also removed: docs/08 specified the species analysis cadence
twice (there and in `time.speciesAnalysisInterval`). Two independently settable fields that must
always agree are a determinism hazard, so `time` is the single source of truth for every phase
cadence.

## 5. Ticks are safe integers, not uint32

`computeStateHash()` fed the tick through `StateHash.word()`, which coerces with `>>> 0`, and
`statelessNoiseU32()` did the same. States exactly 2^32 ticks apart therefore hashed
identically, and per-entity sensory noise repeated with that period.

This is not a theoretical horizon: 2^32 ticks is about 2.1 million simulated years at
`ticksPerSimYear = 2000`, and a fast-forward or soak run at 100× (2000 ticks/s) reaches it in
under a month of wall-clock time.

Now:

- the tick is a JS number constrained to `Number.isSafeInteger`; `MAX_TICK` is exported;
- `StateHash.safeInteger()` feeds any such value as **two** words, low 32 bits then high bits.
  Both are exact over `[0, 2^53-1]` and the pair is injective, verified across the range;
- `statelessNoiseU32()` folds the tick's high word into its seed round, at the cost of one
  multiply. For every tick below 2^32 the high word is zero, so existing noise values are
  bit-identical and remain pinned by golden tests;
- `step()`, `stepMany()` and `fromSnapshot()` refuse to leave the safe range. Saturating
  instead of throwing was rejected: it would make distinct histories share a tick and therefore
  a state hash, destroying hash-as-identity.

BigInt was rejected: it is not JSON-serializable (snapshots are plain data, docs/10 §18), it
allocates on every operation in code that must avoid per-tick allocation, and the per-tick
`tick % interval === 0` scheduling checks would pay for it.

Guidance for later milestones: `tick & 0xffffffff` and `tick | 0` are `ToInt32` operations and
will produce negative values — only `>>> 0` yields the unsigned low word. When the durable
binary snapshot container arrives (docs/06 §21, task K03), the tick must be written as two
uint32 words or a float64; a single uint32 field would reintroduce this bug where it is
unfixable.

## 6. Configuration validation is complete

`validateConfig()` now checks every leaf field of `SimulationConfig` for type and representable
range, plus the cross-field invariants that would otherwise surface as mysterious behaviour
(brain accumulator overflow headroom, carcass decay above 100% per step, a species continuity
threshold that can never stabilize, an unreachable species analysis population, biome threshold
ordering, armor that grants total immunity or forbids movement).

The rule applied throughout: **structural impossibility is rejected, tuning freedom is not.**
Values whose zero means "this mechanism is switched off" — decay, combat damage, cooldowns,
healing, growth cost, mutation spread — must stay legal, because ablation runs are a normal
calibration tool (docs/07 §14). A dedicated test suite asserts thirteen such ablations are
accepted, so a future tightening of the validator cannot quietly outlaw whole experiments.
Signed centi-Celsius fields and the negative brain weight bound are likewise protected.

## 7. Versioning consequences

| Constant                  | Change        | Reason                                                                                       |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------- |
| `ENGINE_VERSION`          | 0.1.0 → 0.1.1 | The canonical hash stream changed (tick as two words) and the hashed config content changed. |
| `CONFIG_SCHEMA_VERSION`   | 1 → 2         | Seven fields left `SimulationConfig`, one duplicate was removed.                             |
| `SNAPSHOT_SCHEMA_VERSION` | 1 → 2         | Snapshot payloads embed a config of the new shape.                                           |
| `PROTOCOL_VERSION`        | unchanged (1) | No wire message shape changed; `HostRuntimeConfig` carries its own schema version.           |

All six golden state hashes were regenerated. Note that they change even at checkpoints far
below 2^32: the extra high word (zero there) still shifts the stream and the word count mixed
into the finalizer. Because the MVP snapshot policy demands an exact engine-version match, any
snapshot produced by engine 0.1.0 is intentionally unloadable.

## 8. Repository and CI

`main` now exists as the integration branch, created at the Milestone 0/1 commit; milestone work
continues on `claude/milestone-*` branches for review before merge. (Switching the repository's
_default_ branch on GitHub is a repository setting and has to be done by the owner.)

CI runs on every push and pull request: Node 22 from `.nvmrc`, pnpm pinned by the
`packageManager` field, `pnpm install --frozen-lockfile`, then `pnpm verify`. A second job runs
the golden fixture twice in separate processes and diffs the output, which additionally proves
no module-level mutable state leaks between runs — something a single-process test suite cannot
show.

## 9. Bookkeeping notes

- CLAUDE.md lists four required version constants. `HOST_RUNTIME_CONFIG_SCHEMA_VERSION` is a
  fifth, deliberately _non-authoritative_ one: it exists so hosting settings can evolve without
  touching the four that gate world identity.
- The workspace `package.json` `version` field (0.1.0) is the repository's own version and is
  independent of `ENGINE_VERSION`. Only `ENGINE_VERSION` gates snapshot compatibility and golden
  hashes.
- Constraint to remember when Milestone 3 adds organisms: `ageTicks` is specified as a
  `Uint32Array` field (docs/03 §6). Ages are per-organism durations, not absolute ticks, and the
  maximum lifespan is 10 000 ticks (docs/08 §7), so uint32 is ample — but any code computing an
  age as `currentTick - birthTick` must do that arithmetic in JS numbers and only then narrow,
  never by storing an absolute tick in a uint32 field.

## 10. Explicitly not done

Milestone 2 remains unstarted. No world generation, environment fields, plants, organisms,
spatial index or renderer code was written. `TASKS.md` C01 stays open: the typed
`SimulationConfig` is complete and fully validated, but C01 belongs to the Milestone 2 block and
is checked off when the environment work that consumes it lands.
