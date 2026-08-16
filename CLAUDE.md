# CLAUDE.md — Implementation Contract

Read this before changing code.

This contract covers **both** the stable MVP foundations (Milestones 0–13, A22–A25 and the
post-A25 corrective passes) and the approved **EvoSim 2.0** roadmap (M14–M25). The MVP hard
rules below are unchanged and still binding. What changed on 2026-08-16 is the scope section:
a flat list of forbidden systems became a **staged** contract. See `docs/11_EVOSIM_2_0.md` for
the roadmap and **ADR 0027 — Emergence first** for the architecture that governs it.

## Mission

Build Project EON as a deterministic artificial-life simulation. Correctness, determinism,
observability and measured performance matter more than visual polish.

When something is ambiguous, prefer the choice that preserves:

1. determinism;
2. engine/presentation separation;
3. general ecological rules over scripted roles;
4. testability;
5. performance;
6. the scope of the milestone in hand.

## Hard rules

### Engine purity

`packages/engine` MUST NOT import React, PixiJS, DOM APIs, IndexedDB, Capacitor, `window`,
`document`, `navigator`, wall-clock APIs or browser lifecycle APIs.

The engine must run in Node tests.

### Determinism

Inside authoritative simulation code:

- NEVER call `Math.random()`.
- NEVER use `Date.now()` or `performance.now()` to decide simulation state.
- NEVER let render FPS affect simulation.
- Use fixed ticks only.
- All randomness must come from an explicit seeded project PRNG (or a stateless
  position/tick hash derived from the world seed).
- Every player action is an immutable versioned command with tick + monotonic sequence.
- Tie-breaking must be explicit, normally lowest `entityId`.
- Avoid unordered iteration when order can change outcomes.
- Do not use transcendental floating-point math in hot authoritative paths where
  deterministic fixed-point/LUT logic is practical.
- Maintain state-hash golden regression tests.

Forbidden as authoritative simulation input, without exception: `Math.random()`, `Date.now()`,
`performance.now()`, render FPS, Worker scheduling timing, browser timing, device performance,
pointer-event frequency, wall clock.

### Authoritative state

Any value capable of affecting a future tick must be deterministic, snapshot-safe,
persistence-safe, rewind-safe, branch-safe, and canonically hashed where appropriate. Derived
visual state may be regenerated instead of stored, provided the regeneration is deterministic.

### Data layout

Use Structure-of-Arrays with TypedArrays for live organism state.

Do not represent thousands of organisms as nested class instances.

Avoid per-tick allocation in hot loops; reuse scratch buffers.

### React boundary

Never store high-frequency organism positions in React state.

React receives low-frequency telemetry, events and selected-entity/species details.

### Renderer boundary

PixiJS is a projection only. It never decides attacks, food allocation, deaths, reproduction,
mutations, species, morphology, signals, disease or authoritative positions.

### Configuration

All tuning constants belong in `SimulationConfig`, named derived constants, or versioned LUTs.

## EvoSim 2.0 approved systems

The following systems are now approved **only** according to the EvoSim 2.0 staged roadmap and
architecture (`docs/11_EVOSIM_2_0.md`, ADR 0027):

- evolvable morphology;
- functional morphology;
- bounded evolvable neural topology;
- recurrent/internal memory;
- richer ecological resources;
- deterministic climate;
- natural environmental events;
- sexual reproduction;
- recombination;
- mate choice;
- sexual selection;
- evolving plants;
- host/pathogen coevolution;
- immune evolution;
- neutral communication channels;
- stigmergy;
- bounded resource carrying;
- low-level environment/material manipulation;
- emergent sociality;
- niche construction;
- geographic isolation;
- macroevolution;
- scientific genetic/environmental interventions.

**They may NOT be implemented ahead of their assigned milestone.**

| Milestone | System                                            |
| --------- | ------------------------------------------------- |
| M14       | Morphological genome                              |
| M15       | Functional morphology                             |
| M16       | Bounded evolvable brain topology + generic memory |
| M17       | Rich ecological resources and niches              |
| M18       | Deterministic climate and natural events          |
| M19       | Sexual reproduction, recombination, mate choice   |
| M20       | Evolving plants and coevolution                   |
| M21       | Pathogens and immune evolution                    |
| M22       | Neutral communication channels                    |
| M23       | Emergent sociality and niche construction         |
| M24       | Geographic isolation and macroevolution           |
| M25       | Life Laboratory interventions                     |

### Staged development rule

Do not implement later EvoSim 2.0 milestone systems early.

- M16 may provide generic memory but must NOT implement sociality.
- M19 may provide sex but must NOT implement social hierarchy.
- M22 may provide neutral communication but must NOT assign signal semantics.
- M23 may provide low-level construction but must NOT implement nests or villages.
- M24 may enable isolation but must NOT manually create species.

## Emergence-first rule

The authoritative engine provides **mechanisms, costs and information**. It never provides a
role, a strategy, a plan or a category.

Authoritative high-level behavior classes and scripted biological roles are **prohibited**:

```text
Predator   Herbivore  Grazer   Scavenger  Pack     Family
Nest       Colony     Community  Tribe    Leader   Home
Village    CivilizationStage     SocialRole         MatePreferencePreset
```

unless they are **purely derived analytical/UI labels with zero effect on authoritative
simulation decisions**.

The engine must never make decisions such as:

```text
if predator        -> attack
if herbivore       -> eat plants
if same species    -> cooperate
if family          -> share food
if colony member   -> return home
if nest exists     -> build nest
if community       -> defend territory
```

Behavior must emerge from general mechanisms instead.

### No scripted behavior functions

Production-authoritative helpers of this shape are prohibited:

```text
huntTogether()   returnHome()      formPack()          buildNest()
createCommunity() buildVillage()   seekMateBySpecies()  followLeader()
```

unless the function is purely UI/analysis and never drives organism decisions. A function
whose name describes a **strategy** rather than a **capability** is the defect. Expose
"transfer energy to the organism ahead", never "share food with kin".

### Derived labels are allowed

Distinguish an **authoritative role** from a **derived observational label**.

Allowed: analytics/UI label a lineage "carnivorous" because measured intake over time is
mostly meat.

Forbidden: the engine sees `role === "carnivore"` and changes feeding or attack behavior.

The test is the direction of causation. If a category the observer invented determines what
the simulation does, it is a defect regardless of what it is named.

## Trade-off rule

**Every major evolvable benefit must have a credible direct or indirect cost/trade-off.**

Examples:

- larger body → more reserves but more energy demand;
- armor → protection but movement/growth cost;
- bigger brain → better behavioral capacity but metabolic cost;
- immunity → resistance but energetic cost;
- signal emission → information but energy cost;
- construction → environmental advantage but energy/material/time cost.

Avoid universal "more is always better" traits. Audit for traits that always maximize or
always minimize; a trait with no cost fixates immediately and stops carrying information.

There must be no free speed, armor, attack, perception, intelligence, immunity, signalling,
sociality, construction, toxin resistance or reproductive success.

## Evolutionary accessibility rule

Features must not merely work in handcrafted fixtures.

Where a system is intended to evolve naturally, controlled evolutionary tests must demonstrate
that there exists an ordinary mutation + inheritance + selection pathway to the behavior —
running the ordinary engine, with realized survival/reproduction as the only fitness.

Applies at least to: scavenging/carnivory; morphology specialization; memory use; signal use;
immune resistance; social cooperation; niche construction; speciation.

Do not require brittle spontaneous stories at a fixed tick/seed ("on seed X at tick 43 700 a
lineage becomes carnivorous" is a lottery ticket, not a test). Do prove evolutionary
reachability in controlled ordinary-engine environments, across multiple seeds where the
outcome is stochastic.

## EvoSim 2.0 performance rule

All new systems must remain bounded. Do not introduce:

- unbounded recursive morphology;
- unbounded NEAT topology;
- unlimited pathogen instances;
- unlimited social graph;
- unlimited construction objects;
- unlimited signal history.

Use bounded structures suitable for thousands of organisms. Prefer SoA, TypedArrays, spatial
indexing, bounded graphs, bounded event histories, scratch buffers, cached derived phenotype
and deterministic compact stores. Avoid O(N²) global work, per-tick object allocation,
unbounded arrays/maps, one Pixi display object per body segment where avoidable, and any
renderer-generated simulation data.

## Permanent scope exclusions

Not approved by EvoSim 2.0 and still forbidden:

- multiplayer;
- auth/accounts;
- cloud saves;
- server-side persistent worlds;
- 3D;
- direct WASD organism control;
- unbounded NEAT topology growth;
- aquatic organisms as a separate locomotion mode.

Dominance/recessiveness is not scheduled; if it becomes desirable it needs its own ADR before
any code.

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

Capacitor packaging exists (M13/A24) and must not fork into a separate mobile app.

## Toolchain policy

- pnpm workspace;
- current stable React, TypeScript and Vite;
- PixiJS 8.x;
- exact dependency versions locked in `pnpm-lock.yaml`;
- Node runtime captured in `.nvmrc`;
- TypeScript strict mode;
- lint + format;
- Vitest;
- Playwright for the interactive vertical slice.

Do not blindly pin stale minor versions from documentation.

## Package responsibilities

### engine

Pure deterministic simulation: fixed math, PRNG, world generation, environment, climate,
spatial index, organisms, ecological genome, morphological genome and development, neural
genome and inference, feeding, combat, reproduction, mutation, recombination, pathogens,
signals, material, species, stats/events, snapshot primitives, state hashing.

### protocol

Versioned worker commands/messages/DTOs. No React/Pixi.

### renderer

PixiJS world renderer, camera, LOD, procedural morphology drawing, selection and overlays. No
simulation decisions and no renderer-side randomness.

### persistence

Browser IndexedDB adapter. No simulation rules.

### ui

React app chrome, inspector, timeline, tree, charts, tools, laboratory.

### apps/web

Composition root: starts worker, renderer, UI and persistence orchestration.

## Development order

MVP order (complete): workspace → PRNG/fixed math → headless shell → world + plants →
organism SoA + movement → sensors + brain → feeding/metabolism/death →
reproduction/mutation → soak → combat/carcasses → worker protocol → Pixi renderer →
observation UI → species/history → interventions → persistence/replay/branching →
performance/calibration → PWA/mobile.

EvoSim 2.0 order (sequential, no skipping): M14 → M15 → M16 → M17 → M18 → M19 → M20 → M21 →
M22 → M23 → M24 → M25 → final adversarial audit.

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
3. changelog entry stating **why** the hashes moved.

UI-only changes must never alter engine hashes. Never regenerate hashes silently.

## Required version constants

```ts
ENGINE_VERSION;
PROTOCOL_VERSION;
SNAPSHOT_SCHEMA_VERSION;
CONFIG_SCHEMA_VERSION;
```

For every authoritative behavior change, evaluate all four plus golden fixture hashes and
persistence compatibility.

## Profiling

Instrument from the first vertical slice:

- total tick;
- environment/climate;
- spatial rebuild;
- sensing;
- brain;
- movement;
- feeding;
- combat;
- metabolism/death;
- reproduction;
- pathogens;
- signals/material;
- species analysis;
- render snapshot generation.

Optimize measured hotspots only.

## Definition of done

A simulation feature is done only if:

- behavior is documented;
- strict types pass;
- deterministic tests exist where applicable;
- evolutionary reachability is demonstrated where the feature is meant to evolve;
- serialization is updated if needed;
- no unexplained magic constants were introduced;
- errors are handled;
- performance impact was measured, not assumed;
- documentation/protocol version was updated when the contract changed.

## Documentation source of truth

If a prompt and this repository's documentation disagree during later work, **update and
document the architectural decision before proceeding** rather than silently overriding
`CLAUDE.md`. An ADR is the mechanism.
