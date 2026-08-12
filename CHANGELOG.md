# Changelog

All notable changes to Project EON. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Golden-hash policy (CLAUDE.md): any intentional authoritative behavior change requires an
`ENGINE_VERSION` bump, regenerated golden hashes and an entry here. UI-only changes must never
alter engine hashes.

## [Unreleased] — Milestone 2.5: debug environment view

Versions: **all four authoritative version constants unchanged** (`ENGINE_VERSION` 0.2.0,
`PROTOCOL_VERSION` 1, `SNAPSHOT_SCHEMA_VERSION` 3, `CONFIG_SCHEMA_VERSION` 3) and **no golden hash
changed** — this is a development tool, and CLAUDE.md requires UI-only work to leave engine hashes
alone. Decisions in `docs/adr/0004-milestone-2-5-debug-environment-view.md`.

### Added

- **Environment debug view** (`apps/web/src/dev/`): a Canvas 2D development tool that generates a
  world from a typed or preset seed and draws it. Seven switchable layers (elevation, biome,
  temperature, moisture, fertility, plant capacity, current biomass), pan/zoom with
  nearest-neighbour scaling, a per-cell hover probe, cell gridlines when zoomed in, and a founder
  region marker. `pnpm dev` now opens it directly.
- **Pure layer painter** (`packages/renderer/src/debug/`): `paintEnvironmentLayer()` projects a
  plain-data `EnvironmentDebugFields` view to RGBA bytes, plus integer colour ramps, the biome
  palette, per-layer legends and `summarizeEnvironmentFields()`. No Pixi, no DOM and no `@eon/engine`
  import, so it runs in Node tests and can back the docs/06 §18 debug overlay (task G10) unchanged.
- **World read-outs**: seed, environment hash, world state hash, config hash, engine version, tick,
  generation attempt, land fraction, mean/min/max temperature, mean fertility, mean moisture, mean
  elevation, plant capacity and biomass totals with saturation, biome distribution and the founder
  region.
- `hashEnvironment()` in `@eon/engine`: a diagnostic digest of the environment arrays alone, under
  its own magic word, answering "is this the same map?" independently of the canonical state hash's
  "is this the same world history?". A pure read — verified not to disturb tick or state hash.
- Six preset seeds, one of which exercises the deterministic world-generation retry path, plus a
  strict seed parser that rejects `"100abc"`, `"1.5"` and out-of-range values instead of coercing
  them (the defect ADR 0002 §6 fixed in the headless CLI).
- Two buttons advancing the world by 1 000 / 10 000 ticks. Beyond the milestone brief and recorded
  as such: at tick 0 biomass is a fixed fraction of capacity everywhere, so the "current biomass"
  layer only carries information once plant growth has run.
- Root `pnpm dev` script, so the documented command works from the workspace root.
- 103 new tests across 9 files: colour-ramp arithmetic, the seven-layer painter against synthetic grids, the
  aggregate summary, the strict seed parser, preset validity, the engine → fields adapter against a
  real generated world, and cross-checks that the debug view's duplicated constants still match the
  engine and that observing a world does not perturb its determinism.

### Fixed (M2.5 review gate)

Review of the debug visualizer. Presentation-only: no version constant and no golden hash moved,
and the engine was not touched. Findings and evidence in
`docs/adr/0004-milestone-2-5-debug-environment-view.md` §12.

- **Advancing the world no longer resets the camera.** The map recentred whenever its field arrays
  were replaced, which is right for a new seed and wrong for `+1 000 ticks` — the same map re-read
  after growth. `DebugWorldModel` now carries a `worldKey` (seed, generation attempt, grid size;
  deliberately not the tick) and the camera keys off that. Zooming into a valley and watching it
  grow works.
- **Hovering the map no longer re-renders the whole tool.** The map, the legend and the world
  read-out are memoized on the world, so a hovered cell rebuilds the eight-row cell panel instead of
  the map component, the rebuilt legend and forty rows of read-out. Script time over 200 hovered-cell
  changes: 82.8 ms → 65.2 ms median, measured with both builds interleaved in one Chromium session.
- **Camera arithmetic extracted to `apps/web/src/dev/debugCamera.ts`** as pure functions over a
  plain record — fit/centre/clamp/pan/zoom-about-a-point/hit-test/visible range — so the map's
  behaviour is testable in Node instead of unreachable inside a component.
- **The golden-fixture preset no longer claims "all six biome classes".** Forest covers three of
  65 536 cells there, which is invisible on the map; the note now says so and a test pins it. The
  no-desert preset's claim is now tested as well, and the `pnpm headless` sample in `README.md`
  regained the `Forest=0.0%` column the CLI actually prints.
- **`pnpm headless` no longer reports tick-0 biomass under a `ticks N` header.** Its world summary
  is printed after generation, so the `plants` line described the world before the run; the run's
  own plant totals are now printed after it (`plants @10000 … 99.3% of capacity`). This is the
  output the debug view is cross-checked against, so it has to describe the tick it claims to.
- 24 new tests — 18 for the extracted camera, 4 for world identity, 2 for the preset claims —
  bringing the suite to 361.

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
