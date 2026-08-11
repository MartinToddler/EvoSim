# ADR 0001 — Milestone 0/1 implementation decisions

Status: accepted · Date: 2026-08-11 · Scope: Milestones 0–1 (tasks A01–A07, B01–B08)

The supplied architecture (CLAUDE.md, docs/01–10) was followed. This ADR records the
implementation-level decisions taken where the specification leaves latitude, so later
milestones can rely on them.

## 1. Source-first workspace packages

Internal packages (`@eon/engine`, `@eon/protocol`, …) expose TypeScript sources directly via
`package.json` `exports` instead of emitting per-package `dist/` artifacts. Vite, Vitest and
tsx all consume TS sources natively; `pnpm build` produces only the web bundle. This keeps the
toolchain simple and removes stale-artifact hazards. If a publishable engine build is ever
needed, a `tsc`/bundler emit step can be added per package without changing import sites.

## 2. Trig LUT built from a deterministic Taylor polynomial

docs/03 §3 requires precomputed sin/cos LUTs but does not prescribe how to build them.
`Math.sin` is implementation-approximated per ECMA-262, so LUT construction uses a fixed-order
Taylor polynomial over the first quadrant (basic IEEE-754 ops only, which are exactly
specified), plus exact quadrant symmetries. On Node/V8 the resulting 4096-entry table is
identical to `Math.round(32767 * Math.sin(...))` for every entry, and it is provably
bit-identical on any conforming engine. The full table is locked by a golden hash test.

## 3. PRNG seeding and derived draw conventions

docs/03 §4 mandates xoshiro128\*\* (or equivalent) with documented vectors. Decisions:

- 128-bit state is expanded from one uint32 seed via four splitmix32 rounds
  (constants 0x9E3779B9 / 0x21F0AAAD / 0x735A2D97); all-zero state falls back to a
  documented constant.
- `nextInt(max)` uses threshold rejection sampling (unbiased).
- `nextQ()` returns [0, Q) — correct for `nextQ() < probabilityQ` comparisons.
- `nextSignedQ()` returns [-Q, +Q] inclusive (unbiased via `nextInt(2Q+1)`).
- `approxNormalQ()` is Irwin–Hall: sum of 12 uniforms on [0, Q] minus 6Q, giving mean 0 and
  σ ≈ Q; callers scale with `qmul(approxNormalQ(), sigmaQ)`. Range [-6Q, +6Q].
- Golden vectors were cross-validated against an independent Python implementation before
  being frozen into tests.

## 4. Canonical state hash algorithm

docs/10 §17 requires hashing arrays without JSON, with explicit lengths. The project-owned
`StateHash` consumes a stream of logical 32-bit words (endianness-independent by
construction), with a tag word + length word before every array. Two lanes with different
seeds/constants use MurmurHash3-style block mixing and finalization; digests are 16 hex chars
(64 bits) to keep fixture collision risk negligible. The canonical word sequence for the
engine state hash is listed in `packages/engine/src/hashState.ts` and locked by the golden
fixture.

## 5. Fixed-point rounding policy

All fixed-point helper divisions truncate toward zero (`Math.trunc` semantics), including for
negative operands, and canonicalize IEEE `-0` to `+0`. This is the single documented rounding
rule required by docs/08 §9.

## 6. Config schema v1 scope

`SimulationConfig` v1 contains every section of docs/02 §17 with the docs/08 v0.1 integer
values. Two areas are deliberately deferred to the milestone that implements them, to avoid
freezing unproven integer encodings now:

- `senses` is an empty section until Milestone 3 (task D05);
- gene mapping ranges (docs/08 §7) join the organism section in Milestone 3 (task D02);
- carcass constants live under `organism.carcass` (docs/02 §17 has no dedicated key).

Each addition will bump `CONFIG_SCHEMA_VERSION` with a changelog entry.

## 7. Snapshot compatibility policy

Core snapshots store `schemaVersion` + `engineVersion` and restoring requires an exact match
of both (docs/06 §28 MVP policy). The durable binary container with `EONSNAP` magic and
payload checksum is deferred to Milestone 10 (K03); Milestone 1 snapshots are the in-memory
plain-data primitive.

## 8. Repository extras kept out

`EON_FULL_IMPLEMENTATION_SPEC.md` (a concatenation of the docs) and `BOOTSTRAP_PROMPT.md`
(one-time bootstrap instructions) were not copied into the repository; `CLAUDE.md`,
`README.md`, `TASKS.md` and `docs/01–10` are the canonical in-repo specification.
