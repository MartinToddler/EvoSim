# Changelog

All notable changes to Project EON. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Golden-hash policy (CLAUDE.md): any intentional authoritative behavior change requires an
`ENGINE_VERSION` bump, regenerated golden hashes and an entry here. UI-only changes must never
alter engine hashes.

## [Unreleased] — 2026-08-13 — Milestone 4 review: reproduction and mutation

Versions: **all unchanged** (`ENGINE_VERSION` 0.4.0, `CONFIG_SCHEMA_VERSION` 5,
`SNAPSHOT_SCHEMA_VERSION` 5, `PROTOCOL_VERSION` 1). **No golden hash moved.** Both fixes below are
outside authoritative behaviour, and every golden was reproduced from scratch to prove it: the six
fixture hashes at ticks 0/1/10/100/1000/10000 and the 100 000-tick soak hash `8f88a197654c098b`.
Evidence and the full risk-by-risk review in `docs/adr/0007-milestone-4-review.md`.

### Fixed

- **`pnpm verify` failed on a wall clock rather than on a hash.** `testTimeout` was 300 s, derived
  from a ~150 s measurement of the 10 000-tick reference world. Vitest runs test files in parallel
  workers, so that test competes with the 100 000-tick soak and the other acceptance suites and
  actually costs 429–520 s inside the suite against 188 s standalone — a 2.3–2.8x contention factor.
  Two **mandated** acceptance tests timed out (`goldenFixture` state hashes, `organismSimulation`
  resume-to-10 000); 486 of 488 tests passed and both failures were timeouts with no assertion
  involved. docs/07 §8 forbids enforcing an arbitrary CI wall clock on unknown hardware, so the
  budgets are now hang detectors: global `testTimeout` 300 s → **600 s**, and **1 800 000 ms** inline
  on the two 10 000-tick determinism tests and on the 100 000-tick environment soak, matching the
  value `soak.test.ts` already used. Measured costs are recorded in the config comment.
- **A cooldown above the Uint16 bound was accepted by `validateConfig` and then silently wrapped.**
  `reproduction.reproductionCooldownTicks` was checked only as a non-negative integer, while the
  counter it drives is a `Uint16Array` row of `OrganismStore` — and a `Uint16Array` assignment wraps
  rather than clamps. A configured 70 000 was stored as 4 464, so the parent came off cooldown 65 536
  ticks early and reproduced roughly fifteen times more often than configured, with nothing
  reporting a problem. Both `reproduction.reproductionCooldownTicks` and
  `combat.attackCooldownTicks` (same shape against the `attackCooldown` row, written from Milestone 5)
  are now bounded by their storage width, as every gene range and `plants.baseCapacityByBiome`
  already were. The check only ever rejects more configurations; `DEFAULT_CONFIG` is unaffected and
  the config shape is unchanged.

### Added

- **`genetics/mutationStatistics.test.ts`** — the distribution `mutation.test.ts`'s mechanism tests
  do not cover. Over 200 000 deterministic births: 1.361 genes and 8.375 weights changed per birth
  against 1.363 and 8.398 predicted by the roll partition, weight-delta standard deviation 398.8
  against 398.7 predicted by the two-class mixture, and a delta mean of 0.16 against a standard error
  of 0.31 — which is what proves `qmul`'s truncation is symmetric rather than a per-mutation downward
  bias. Also the **no-mutation** fixture (byte-identical genome and brain across 1 000 births, still
  spending exactly 416 classification draws) and the **forced-mutation** fixture (accepted at the
  `sum == Q` boundary, every locus perturbed, 1 000 forced generations inside every bound, uniform
  forced reset across the whole raw span).
- **`evolutionContinuity.test.ts`** — save/load restored at **every** tick of a 48-tick window that
  straddles both the 20-tick environment cadence and the 40-tick reproduction cooldown, each
  continued 24 ticks, with the free list, `nextEntityId`, generation, parent links, cooldowns and the
  diagnostics counters checked by name as well as through the hash. Sampling chosen ticks cannot
  catch a field that is only sometimes load-bearing, and reproduction creates several. Plus the
  docs/07 §12 brain-degradation guard: mean cosine similarity to the founder brain stays above 0.5
  and weights on the clamp stay under 1%. Measured at 40 000 ticks the similarity is 0.896 after 26
  generations, so the bound is loose by design (docs/07 §1 forbids asserting an evolutionary story).
- **A whole-phase energy ledger test** in `ecology/reproduction.test.ts`: across 400 simultaneous
  births spanning the investment × size grid, the population's total energy must fall by _exactly_
  the increase in `birthEnergyDiscarded`. The existing tests balance one birth at a time, which
  cannot catch an accumulation error — a discard credited to the wrong parent balances per birth and
  not in aggregate. Measured: −1 517 965 against +1 517 965.
- **Storage-width validation tests** in `config/validateConfig.test.ts` for both cooldowns, at the
  bound and one past it.

## [0.4.0] — 2026-08-13 — Milestone 4: asexual reproduction, mutation and evolution

Versions: `ENGINE_VERSION` 0.3.1 → **0.4.0**; `CONFIG_SCHEMA_VERSION` 4 → **5**;
`SNAPSHOT_SCHEMA_VERSION` 4 → **5**; `PROTOCOL_VERSION` unchanged (1). **Every golden hash was
regenerated.** Decisions and evidence in `docs/adr/0006-milestone-4-evolution.md`.

### Added

- **Phase 14, `resolveReproduction`** (`ecology/reproduction.ts`). Asexual only. An organism must be
  alive, at or past its genetic maturity age, at or above 90% realized development, off cooldown,
  asking through its brain's reproduce output, and holding enough energy for the child's endowment
  plus its own 20% reserve. The brain's output is a request, never a permission.
- **Mutation** (`genetics/mutation.ts`). One uniform draw per locus selects between disjoint reset,
  large, small and none classes, so each marginal probability is exactly the configured value and the
  outcomes cannot combine. 16 genes then 400 weights, in that fixed order. Ecological sigmas are Q
  fractions of the normalized gene range; brain sigmas are in stored weight units, as docs/08 §17
  words them. No crossover.
- **`mutation.brain.weightLargeSigmaQ`** (1476 = 0.36 weight units). docs/04 §18 and docs/08 §17 give
  the brain block a large-mutation probability and no large sigma; the value applies the 6x
  large/small ratio the ecological block does specify. Only new config field in the milestone.
- **Three new authoritative fields**, all hashed and serialized: per-slot `reproductionCooldown`,
  and the cumulative counters `capRejectedBirths` and `birthEnergyDiscarded`.
- **`OrganismStore.canAllocate()`**, so reproduction can check the population cap _before_ drawing
  any randomness. A birth refused by the cap now consumes nothing from the PRNG and cannot shift the
  random stream of the organisms after it.
- **`pnpm sweep`** (task E08). Runs a config variant across many seeds and reports population, peak,
  births, deaths, generations, trait variance, biomass, cap rejections, final hash and wall time as a
  table, CSV or JSON. Analytics live in `scripts/populationStats.ts`, outside `packages/engine`, so
  docs/05 §21's "analytics never feed back into selection" is structural.
- **`soak.test.ts`** — the 100 000-tick evolutionary soak (task E07), on a 96x96 / 64-founder world.
  Sweeps identity, slot-bookkeeping, energy, health, body and lineage invariants every 997 ticks,
  carries over every environment invariant from the Milestone 2 soak, and round-trips a snapshot at
  tick 100 000. Measured: 50 716 births, 50 280 deaths, generation 63, no cap rejections, ~350 s.
- **`evolutionSimulation.test.ts`** — Milestone 4 acceptance on the reference world, plus the closed
  -system energy test: in a world with no food the population's total energy is asserted
  non-increasing on every one of 2 500 ticks while reproduction is running.
- **Mutation golden fixture** (`fixtures/mutationGolden.json`): exact genes and brain digest after a
  50-generation lineage, and the PRNG draw count of a single birth (572 words).

### Changed

- **The reference world no longer empties.** Before this milestone the founder cohort died of old age
  together at tick 6 100 and tick 10 000 held zero organisms. It now holds ~4 700. Milestone 3
  acceptance assertions that depended on "nothing reproduces yet" were rewritten, not deleted.
- **`world/environmentSoak.test.ts` runs a lifeless world** (`initialOrganisms = 0`). Its assertions
  describe the plant model and were only true because grazing was negligible; isolating them keeps
  them meaningful and makes the run nearly free. `validateConfig` now accepts zero founders —
  a lifeless control world is a legitimate configuration.
- **`SpawnRequest.energy` is a discriminated union.** A founder is endowed as a fraction of its own
  maximum; a child is endowed with an absolute amount its parent paid. Both are clamped to the
  newborn's own maximum in one place.
- **Vitest's global timeout rose from 60 s to 300 s**, and long-run engines are shared within a test
  file. A 10 000-tick reference run costs ~150 s now that the population persists, against ~9 s
  before.
- **Ecological mutation sigmas are validated as Q fractions** (tightened from "non-negative"), which
  is both the meaningful bound and what keeps `geneDeltaRaw`'s product exact.
  `reproduction.spawnAngleCandidates` is now bounded by `ANGLE_STEPS`.

### Notes

- **Energy is never created by a birth.** The parent pays its full offspring investment; the child
  receives that amount clamped to what its newborn body can hold; the surplus is destroyed and
  counted in `birthEnergyDiscarded`. Charging the parent only the usable part would make every
  investment gene above the saturation point free, and a free gene drifts to its maximum.
- **The world's carrying capacity is far above the 8 192 organism safety cap.** Measured across six
  seeds at 10 000 ticks: all six survive, and **three are pinned at the cap** with 5.5–6.1 million
  refused births. The capped seeds' trait spread is about half the uncapped seeds' — the concrete
  form of docs/01 §11's warning that the cap biases evolution — and docs/01 §12 makes not slamming
  the cap an MVP release gate. This was deliberately **not** tuned: docs/08 §24 requires implementing
  the defaults faithfully first, and docs/07 §14 requires 10–30 seeds before a tuning conclusion. It
  is input for task L07, and `pnpm sweep` is the harness. Full table in ADR 0006 §7.
- **This line does not include the Milestone 0–2 foundation-gate branch**
  (`claude/evosim-project-setup-ps3fry`). Milestone 4 depends on Milestone 3, which descends directly
  from the Milestone 2 commit, and none of the six foundation defects threaten this milestone.
  The merge must happen before Milestone 9 (terrain edits). See ADR 0006 §0.

## [0.3.1] — 2026-08-12 — Milestone 3 independent review

Versions: `ENGINE_VERSION` 0.3.0 → **0.3.1**; snapshot, config and protocol schema versions
unchanged. **Golden hashes are unchanged** — the behavior that changed is never reached by the
reference fixture, and the fixture file records why. Findings and evidence in
`docs/adr/0005-milestone-3-review-fixes.md`.

### Fixed

- **Coincident bodies separated in slot order instead of entity-ID order.** When two organisms sit
  at exactly the same position, docs/03 §13 derives the separation direction from an entity-ID
  hash. The implementation hashed `(idOfLowerSlot, idOfHigherSlot)`, so once slots are recycled
  (Milestone 4) the same two organisms would fly apart differently depending only on who died
  recently — storage order deciding an authoritative outcome. Both the hash arguments and the push
  direction are now ordered by entity ID. The reference world never places two organisms on exactly
  the same sub-unit, so no golden hash moved; `ENGINE_VERSION` is bumped because the engine
  computes something different in a state that is reachable in general, and snapshot restore must
  keep refusing to continue a 0.3.0 world under 0.3.1 rules.
- **`OrganismStore.allocateSlot` could lose a slot.** The entity-ID exhaustion assertion ran after
  the free stack had been popped, so a slot could end up neither alive nor free — permanently
  unusable. The cap check and the assertion now both precede any mutation.
- **Snapshot restore trusted a malformed free list.** `adoptSlotState` accepted a free list naming
  the same slot twice (which would put two organisms in one slot) and one that omitted a dead slot
  (which would leak it forever). Restore now rejects duplicates and enforces
  `liveCount + freeCount === slotHighWater`.

### Added

- Regression tests for all three fixes, plus a snapshot/resume test taken at a tick that is **not**
  a multiple of the environment interval — the case that hid the stale plant-gradient cache fixed
  in 0.3.0.

## [0.3.0] — 2026-08-12 — Milestone 3: organism mechanics

Versions: `ENGINE_VERSION` 0.2.0 → **0.3.0**, `CONFIG_SCHEMA_VERSION` 3 → **4**,
`SNAPSHOT_SCHEMA_VERSION` 3 → **4**, `PROTOCOL_VERSION` unchanged (1). All golden hashes
regenerated; 0.2.x snapshots are intentionally unloadable. Decisions in
`docs/adr/0004-milestone-3-organism-mechanics.md`.

### Added

- **Structure-of-Arrays organism store** (D01): every field a TypedArray indexed by slot, LIFO
  free list, monotonic never-reused uint32 entity IDs with 0 invalid, ascending-slot authoritative
  iteration. Released slots are cleared so the state hash cannot depend on the history of the dead.
- **16-gene ecological genome and phenotype mappings** (D02/D03): quantized Uint16 genes, a signed
  diet gene with squared-affinity digestion efficiency, and the docs/08 §7 ranges in engine units.
  The derived phenotype is cached per organism and recomputed from the genome on load.
- **Deterministic integer roots and powers** (`math/isqrt.ts`): exact `isqrt`, plus `powQ` for the
  nonlinear size/speed/vision responses. `Math.sqrt` and `**` are implementation-approximated by
  ECMA-262 and cannot appear in authoritative code.
- **Spatial hash** (D04): 128×128 head/next grid rebuilt twice per tick, keeping vision and
  crowding queries off the O(N²) path.
- **Twenty sensors** (D05) exactly as docs/08 §18 defines them, with direction reaching the brain
  as forward/lateral components rather than a bearing. No sensor is omniscient: there is no species
  identity, no predator flag and no global knowledge.
- **Quantized 20 → 12 → 5 network with skip connections** (D06) and the calibrated founder genome
  and controller (D07), both hash-tested fixtures.
- **Intent arrays** (D08): throttle, turn, eat, attack, reproduce, declared in one phase and
  resolved in later ones so no organism benefits from a lower slot index.
- **Movement, terrain and soft collisions** (D09): fixed-step integration with a sub-sub-unit
  remainder, armor speed penalty, size turn penalty, water slowdown and grace period, a clamping
  world boundary and order-independent overlap separation.
- **Plant feeding claims** (D10): per-cell aggregation, proportional allocation and an integer
  remainder handed to the lowest entity IDs. Biomass is conserved exactly.
- **Metabolism, growth, thermal stress, aging and death** (D11–D13): capability-scaled basal
  upkeep, movement energy from realized effort, energy-limited growth, starvation, drowning,
  thermal damage above a documented severe threshold, passive healing and a hard genetic maximum
  age. Deaths are collected during physiology and finalized in ascending slot order.
- **Founder population** spawns into the founder region before tick 0, from the world PRNG. It is
  the only PRNG consumer in this milestone; every tick phase is deterministic without drawing.
- **Organism snapshots**: the used slot prefix, genomes, brains and the free list verbatim.
- Headless runner reports population, mean energy, mean development, plant intake and deaths by
  cause at every checkpoint (docs/10 §26).

### Fixed

- **The specified founder starved without ever attempting to feed.** docs/08 §18 pins
  `carcassProximity` at -Q whenever no carcass is in range — always, before Milestone 5 — and
  docs/08 §20 gives the founder's eat output a +0.40 weight on it, so the intended bonus acted as a
  permanent -0.40 tax. Measured on the reference world the eat output was 0.354 against a 0.55
  threshold at every tick of every founder's life, and all 256 starved by tick ~600. The founder's
  eat bias is recalibrated to +1.10 (+0.10 as specified, +0.40 cancelling the absent-carcass state,
  +0.60 placing the feeding floor at a quarter of a cell's capacity). This is calibration of an
  ordinary inheritable weight, which docs/07 §15 and docs/08 §21 anticipate — not a survival bonus.
- **The cached plant gradient made snapshot resume diverge.** Milestone 2 cached the gradient and
  refreshed it on the 20-tick environment cadence, which was sound only while nothing changed
  biomass in between. Organisms graze every tick, so the cache went stale — and a restore
  recomputed it from the current biomass, making a resumed run sense a different world than the
  continuous one. The bug hid whenever the snapshot fell on a multiple of the environment interval.
  The gradient is now computed where it is read (`plantGradientXQAt` / `plantGradientYQAt`), which
  makes it a pure function of the biomass field and is also cheaper: the 100 000-tick soak dropped
  from 80 s to 33 s.
- **`geneFromQ` was off by one quantum.** Scaling by `GENE_RAW_MAX / Q` looks like the inverse of
  the gene normalization but is not (65535/4096 is 15.99975, not 16), so the round trip lost a step
  and would have shifted founder genes downward.

### Changed

- Determinism acceptance in `SimulationEngine.test.ts` runs at 1000 ticks; the 10 000-tick cases
  moved to the Milestone 3 acceptance suite and the golden fixture, which pin exact hashes.
- `SpatialGrid.rebuild` clears only previously occupied cells. Blanket-clearing two 128×128 grids
  costs 32 768 writes per tick whatever the population is, which dominated the 100 000-tick soak.
- Vision and crowding queries hoist their typed arrays into locals and reject candidates that
  cannot beat the incumbent before the field-of-view test: 32.7 → 29.6 ms per tick at 5000
  organisms, with identical hashes.

## [0.2.0] — 2026-08-12 — Milestone 2: environment

Versions: `ENGINE_VERSION` 0.1.1 → **0.2.0**, `CONFIG_SCHEMA_VERSION` 2 → **3**,
`SNAPSHOT_SCHEMA_VERSION` 2 → **3**, `PROTOCOL_VERSION` unchanged (1). All golden hashes
regenerated; 0.1.x snapshots are intentionally unloadable. Decisions in
`docs/adr/0003-milestone-2-environment.md`.

### Added

- **Deterministic value noise** (C02): integer lattice noise with smoothstep interpolation,
  per-field salts, power-of-two wavelengths. No floats, no PRNG draws — world generation is a
  pure function of (seed, config) and leaves the PRNG untouched.
- **Procedural world generation** (C03–C06): elevation from three octaves with an ocean-forming
  edge fade; moisture from noise, inverse elevation and a coastal water-influence gradient;
  temperature from latitude, elevation and low-frequency noise (≈ -13 °C … +33 °C); fertility
  from moisture, temperature, lowland preference and noise; biome classification in the
  documented rule order; per-cell plant capacity from biome base × fertility × moisture and
  temperature suitability.
- **World validity with deterministic retry** (C03): land fraction, connected habitat size,
  total capacity and biome diversity are checked; an invalid world is regenerated from a derived
  sub-seed rather than repaired. All ten calibration seeds pass.
- **Plants as a biomass field with logistic growth and a seed bank** (C06/C07), plus the cached
  plant gradient organism sensing will read.
- **Founder region selection** (C08): the most productive neighbourhood inside the largest
  connected landmass, chosen deterministically.
- **Environment phase in `step()`**: phase 1 of the docs/03 §7 tick order now runs on the
  configured interval; environment arrays are hashed and serialized.
- **Environment tests** (C09): noise, biome rule order, capacity and growth arithmetic,
  generation invariants, validity and retry, founder region, and a 100 000-tick soak that pins
  the resulting state hash.
- Headless runner prints a world summary (land share, biome distribution, capacity, biomass,
  founder region).

### Fixed

- **Sparse plant cells froze permanently.** With integer biomass and a truncated logistic step, a
  cell below ≈84 biomass (≈683 in a slow biome) grew by exactly zero, while the seed bank stopped
  at 16 — so any cell grazed into that gap could never recover, silently and only in some biomes.
  Growth now carries its fractional part between steps in a new authoritative array. Rounding up
  to a minimum of one unit was rejected: it would have made slow biomes recover up to seven times
  faster than configured.

### Changed

- `vitest.config.ts` sets a 60 s default test timeout: the acceptance tests generate whole worlds
  and run thousands of ticks, and the 5 s default failed them for being slow rather than wrong.
- Moisture dilation, flood fill and the gradient pass no longer allocate a neighbour array per
  cell (~1.5 M allocations per world); generation dropped from 122 ms to 90 ms with identical
  output.

## [0.1.1] — 2026-08-12 — Milestone 1 hardening (review fixes)

Versions: `ENGINE_VERSION` 0.1.0 → **0.1.1**, `CONFIG_SCHEMA_VERSION` 1 → **2**,
`SNAPSHOT_SCHEMA_VERSION` 1 → **2**, `PROTOCOL_VERSION` unchanged (1), new
`HOST_RUNTIME_CONFIG_SCHEMA_VERSION` = 1.

**All golden state hashes changed and snapshots written by engine 0.1.0 are intentionally
unloadable** (MVP policy requires an exact engine-version match, docs/06 §28). Rationale and
the contested judgement calls are recorded in `docs/adr/0002-milestone-1-hardening.md`.

### Fixed

- **Authoritative state was reachable from outside the engine.** `SimulationEngine.rng` was
  public, so any caller could advance the PRNG outside a tick, and `restoreCore()` could
  overwrite tick and PRNG state. The generator is now a private field reachable only through a
  package-internal channel (`internal.ts`, not exported from the package), the public API
  offers just a detached `getRngState()`, and `SimulationEngine.fromSnapshot()` is the single
  validated restore path. A lint rule blocks deep imports that would bypass the boundary, and the
  engine instance is frozen so that `configHash` — `readonly` only in TypeScript — cannot be
  reassigned at runtime to change a world's hash without changing any simulation value.
- **A caller's config could drift away from its own hash.** The engine stored the caller's
  object by reference, so mutating it after construction left `configHash` describing something
  else. The constructor now clones, validates the clone, deep-freezes it and hashes that same
  object — in that order, so a config with getters cannot show different values to the
  validator and to the hash. `engine.config` is `DeepReadonly`; seeds must be integers
  (`1.5 >>> 0` and `NaN >>> 0` silently collapsed distinct seeds onto one world).
- **Ticks were truncated to 32 bits** in the state hash and in stateless noise, so states
  exactly 2^32 ticks apart hashed identically and per-entity noise repeated with that period —
  reachable in under a month of wall-clock time at 100× speed. Ticks are now safe integers
  hashed as two words via `StateHash.safeInteger()`, noise folds the tick's high bits into its
  seed round, and `step()`/`stepMany()`/`fromSnapshot()` refuse to leave the safe range.
  `MAX_TICK` is exported.
- **Hosting values changed world hashes.** `SimulationConfig` now holds authoritative constants
  only; `targetTicksPerSecond1x`, `normalRenderSnapshotsPerSecond`,
  `maxModeRenderSnapshotsPerSecond`, `maxWorkerSliceMs`, `autosaveCheckInterval`,
  `ticksPerSimYear` and `maxDetailedRenderedOrganisms` moved to a new `HostRuntimeConfig` in
  `@eon/protocol`, with its own schema version and validator. Changing a render cadence can no
  longer alter a world's identity.
- **Duplicated cadence removed.** docs/08 defined the species analysis interval twice
  (`species.analysisIntervalTicks` and `time.speciesAnalysisInterval`); two fields that must
  always agree are a determinism hazard. `time` is now the single source of truth.
- **The headless CLI accepted malformed input.** `"100abc"` parsed as 100 and `"1.5"` as 1.
  Arguments are now strictly validated, bounded, and out-of-range seeds are rejected instead of
  silently coerced.

### Added

- Complete `validateConfig()` coverage: every leaf field is range-checked, plus cross-field
  invariants (brain accumulator headroom, decay above 100% per step, unstabilizable species
  thresholds, biome threshold ordering, armor granting immunity or forbidding movement).
  Structural impossibility is rejected while tuning freedom is preserved — a test suite asserts
  that thirteen "mechanism switched off" ablations remain legal.
- A frozen inventory of the 113 config fields that enter the world hash, so a future
  host-flavoured field fails a test instead of silently changing world identity.
- CI (`.github/workflows/verify.yml`): every push and pull request runs Node 22 + pnpm with a
  frozen lockfile and `pnpm verify`; a second job re-runs the engine goldens on macOS, Windows
  and Node 24 to catch cross-platform determinism drift.
- `main` branch as the integration target for milestone branches.

## [0.1.0] — 2026-08-11 — Milestones 0–1

### Added

- **Milestone 0 — Repository (A01–A07)**
  - pnpm workspace: `apps/web` + `packages/{engine,protocol,renderer,persistence,ui,shared}`.
  - Vite + React + TypeScript web shell (status page only; no world/renderer by design).
  - Strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …).
  - ESLint (type-checked) + Prettier; engine purity is mechanically enforced by lint rules
    (no browser globals/timers, no `Math.random`, no `Date.now`/`performance.now`/`new Date`,
    no React/Pixi imports inside `packages/engine`).
  - Vitest across the workspace; `pnpm verify` = typecheck + lint + test + build.
  - Version constants: `ENGINE_VERSION = "0.1.0"`, `PROTOCOL_VERSION = 1`,
    `SNAPSHOT_SCHEMA_VERSION = 1`, `CONFIG_SCHEMA_VERSION = 1`.
  - Toolchain pinned via `pnpm-lock.yaml` + `save-exact`; Node 22 via `.nvmrc`;
    PixiJS 8.19.0 pinned in `@eon/renderer` (unused until Milestone 6).
- **Milestone 1 — Determinism skeleton (B01–B08)**
  - Fixed-point helpers (`Q=4096`, `POS_SCALE=256`, `ANGLE_STEPS=4096`, `TRIG_SCALE=32767`);
    documented truncate-toward-zero rounding policy.
  - Angle helpers and deterministic sin/cos LUT built from a fixed-order Taylor polynomial
    (IEEE-754 basic ops only — bit-identical on every JS engine; golden table hash locked).
  - Project-owned PRNG: xoshiro128\*\* with splitmix32 seeding; methods
    `nextU32/nextInt/nextQ/nextSignedQ/approxNormalQ` (Irwin–Hall) +
    `serializeState/restoreState`. Golden vectors cross-validated against an independent
    reference implementation.
  - Stateless hash noise `(seed, entityId, tick)` for later per-entity sensory noise.
  - Canonical state hash: project-owned dual-lane 32-bit word hasher (MurmurHash3-derived
    mixing) with tagged, length-prefixed array framing; 64-bit hex digests.
  - Typed `SimulationConfig` shell + frozen `DEFAULT_CONFIG` with docs/08 v0.1 values,
    structural validation and canonical (sorted-key) config hash.
    `senses` and gene-mapping ranges intentionally deferred to Milestone 3 (schema bump).
  - `SimulationEngine` empty fixed-step shell (`step`/`stepMany`, no deltaTime),
    core snapshot serialize/restore with exact-engine-version compatibility policy.
  - Headless runner `scripts/headless.ts` (`pnpm headless --seed … --ticks … --checkpoints …`).
  - **Golden deterministic fixture** (`packages/engine/src/fixtures/goldenStateHashes.json`):
    seed `0xE0A12026`, `DEFAULT_CONFIG`, empty command log; canonical state hashes locked at
    ticks 0, 1, 10, 100, 1 000, 10 000. Acceptance tests: 10 000 empty ticks deterministic;
    continuous run == serialize@2 500 → restore → continue.

### Notes

- Internal packages are consumed source-first (package `exports` point at `src/`); the only
  build artifact is the Vite web bundle. See `docs/adr/0001-milestone-0-1-implementation-decisions.md`.
