# Changelog

All notable changes to Project EON. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Golden-hash policy (CLAUDE.md): any intentional authoritative behavior change requires an
`ENGINE_VERSION` bump, regenerated golden hashes and an entry here. UI-only changes must never
alter engine hashes.

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
