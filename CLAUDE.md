# CLAUDE.md — Implementation Contract

Read this before changing code.

## Mission

Build Project EON as a deterministic artificial-life simulation. Correctness, determinism, observability and measured performance matter more than visual polish.

When something is ambiguous, prefer the choice that preserves:

1. determinism;
2. engine/presentation separation;
3. general ecological rules over scripted roles;
4. testability;
5. performance;
6. MVP scope.

## Hard rules

### Engine purity

`packages/engine` MUST NOT import React, PixiJS, DOM APIs, IndexedDB, Capacitor, `window`, `document`, `navigator`, wall-clock APIs or browser lifecycle APIs.

The engine must run in Node tests.

### Determinism

Inside authoritative simulation code:

- NEVER call `Math.random()`.
- NEVER use `Date.now()` or `performance.now()` to decide simulation state.
- NEVER let render FPS affect simulation.
- Use fixed ticks only.
- All randomness must come from an explicit seeded project PRNG.
- Every player action is an immutable versioned command with tick + monotonic sequence.
- Tie-breaking must be explicit, normally lowest `entityId`.
- Avoid unordered iteration when order can change outcomes.
- Do not use transcendental floating-point math in hot authoritative paths where deterministic fixed-point/LUT logic is practical.
- Maintain state-hash golden regression tests.

### Data layout

Use Structure-of-Arrays with TypedArrays for live organism state.

Do not represent thousands of organisms as nested class instances.

Avoid per-tick allocation in hot loops; reuse scratch buffers.

### React boundary

Never store high-frequency organism positions in React state.

React receives low-frequency telemetry, events and selected-entity/species details.

### Renderer boundary

PixiJS is a projection only. It never decides attacks, food allocation, deaths, reproduction, mutations, species or authoritative positions.

### Configuration

All tuning constants belong in `SimulationConfig`, named derived constants, or versioned LUTs.

### Scope exclusions until explicitly approved

Do not implement:

- sexual reproduction / mate choice;
- dominance/recessiveness;
- aquatic organisms;
- pathogens/parasites;
- nests/construction;
- communication/language;
- evolving NN topology / NEAT;
- multiplayer;
- auth/accounts;
- cloud saves;
- server-side persistent worlds;
- 3D;
- direct WASD organism control.

## Target workspace

```text
/
├─ apps/
│  └─ web/
├─ packages/
│  ├─ engine/
│  ├─ protocol/
│  ├─ renderer/
│  ├─ persistence/
│  ├─ ui/
│  └─ shared/
├─ docs/
├─ scripts/
├─ CLAUDE.md
├─ README.md
├─ TASKS.md
├─ package.json
├─ pnpm-workspace.yaml
└─ tsconfig.base.json
```

Do not create a separate mobile app during MVP. Add Capacitor after the web implementation is stable.

## Toolchain policy

At bootstrap:

- use pnpm workspace;
- use current stable React, TypeScript and Vite available at implementation time;
- use PixiJS 8.x;
- lock exact dependency versions in `pnpm-lock.yaml`;
- capture Node runtime in `.nvmrc` or equivalent;
- TypeScript strict mode;
- lint + format;
- Vitest;
- add Playwright when the first interactive vertical slice exists.

Do not blindly pin stale minor versions from documentation.

## Package responsibilities

### engine

Pure deterministic simulation: fixed math, PRNG, world generation, environment, spatial index, organisms, genome, neural inference, feeding, combat, reproduction, mutation, species, stats/events, snapshot primitives, state hashing.

### protocol

Versioned worker commands/messages/DTOs. No React/Pixi.

### renderer

PixiJS world renderer, camera, LOD, selection and overlays. No simulation decisions.

### persistence

Browser IndexedDB adapter. No simulation rules.

### ui

React app chrome, inspector, timeline, tree, charts, tools.

### apps/web

Composition root: starts worker, renderer, UI and persistence orchestration.

## Required development order

1. workspace + verification scripts;
2. deterministic PRNG/fixed math;
3. headless engine shell;
4. deterministic world + plants;
5. organism SoA + movement;
6. sensors + neural brain;
7. feeding/metabolism/death;
8. reproduction/mutation;
9. headless evolutionary soak test;
10. combat/carcasses;
11. worker protocol;
12. Pixi renderer;
13. observation UI;
14. species/history;
15. player interventions;
16. persistence/replay/branching;
17. performance/calibration;
18. PWA/mobile preparation.

Do not start with a polished map.

## Mandatory deterministic fixture

Maintain:

```text
seed: 0xE0A12026
config: DEFAULT_CONFIG
commands: fixed fixture log
```

Store canonical state hashes after ticks:

```text
0, 1, 10, 100, 1_000, 10_000
```

Intentional engine behavior changes require:

1. `ENGINE_VERSION` bump;
2. updated golden hashes;
3. changelog entry.

UI-only changes must never alter engine hashes.

## Required version constants

```ts
ENGINE_VERSION
PROTOCOL_VERSION
SNAPSHOT_SCHEMA_VERSION
CONFIG_SCHEMA_VERSION
```

## Profiling

Instrument from the first vertical slice:

- total tick;
- environment;
- spatial rebuild;
- sensing;
- brain;
- movement;
- feeding;
- combat;
- metabolism/death;
- reproduction;
- species analysis;
- render snapshot generation.

Optimize measured hotspots only.

## Definition of done

A simulation feature is done only if:

- behavior is documented;
- strict types pass;
- deterministic tests exist where applicable;
- serialization is updated if needed;
- no unexplained magic constants were introduced;
- errors are handled;
- performance impact was considered;
- documentation/protocol version was updated when contract changed.

## First action in a fresh repository

Implement only Milestone 0 and Milestone 1 from the roadmap. Do not proceed to world generation until tests, typecheck, lint and build pass.
