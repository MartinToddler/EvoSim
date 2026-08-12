# Project EON — Artificial Life / Digital Evolution Simulator

> Implementation specification v0.1 — 2026-08-11  
> Codename: EON (working name only)  
> Primary target: Web MVP  
> Future targets: iOS + Android from the same web codebase

## Product in one sentence

EON is a deterministic, top-down 2D artificial-life sandbox in which autonomous organisms with inheritable genomes and neural controllers live, feed, compete, reproduce, mutate, speciate and go extinct in a persistent procedurally generated ecosystem whose environmental pressures can be altered by the player.

## Non-negotiable product principles

1. **Emergence over scripting.** Do not script predator, prey, herd, migration, adaptation or species success.
2. **Indirect player agency.** The player changes selection pressures; organisms choose their own actions.
3. **No explicit fitness function.** Fitness is realized reproductive success.
4. **Observable causality.** The user must be able to connect interventions, ecological changes and evolutionary outcomes.
5. **Visible evolution.** Important inherited traits should affect phenotype whenever practical.
6. **Deterministic engine.** Same engine version + seed + config + command stream must reproduce the same authoritative state.
7. **Engine/render separation.** The simulation core must run headlessly without React, PixiJS, DOM or browser APIs.
8. **Web-first, mobile-capable.** Architecture must allow later Capacitor packaging without rewriting the simulation.
9. **MVP discipline.** No sexual reproduction, diseases, parasites, aquatic life, construction, evolving NN topology, multiplayer or backend simulation before MVP acceptance.
10. **Tuning is data.** Biological/ecological constants live in versioned configuration, never unexplained magic numbers in hot loops.

## Documentation order

Claude Code should read:

1. `CLAUDE.md`
2. `docs/01_PRODUCT_AND_SCOPE.md`
3. `docs/02_ARCHITECTURE_AND_PROTOCOL.md`
4. `docs/03_SIMULATION_WORLD.md`
5. `docs/04_ORGANISM_GENOME_BRAIN.md`
6. `docs/05_EVOLUTION_HISTORY.md`
7. `docs/06_RENDERING_UI_PERSISTENCE.md`
8. `docs/07_TESTING_PERFORMANCE_ROADMAP.md`
9. `docs/08_DEFAULT_CONFIG_AND_FOUNDER.md`
10. `docs/09_FUTURE_ARCHITECTURE.md`
11. `docs/10_CODEBASE_BLUEPRINT.md`
12. `TASKS.md`
13. `BOOTSTRAP_PROMPT.md`

A concatenated version is also provided as `EON_FULL_IMPLEMENTATION_SPEC.md`.

## MVP success definition

The MVP is successful when a user can:

- create a deterministic world from a seed;
- watch at least 2,000 organisms smoothly, with a desktop design target of 5,000;
- observe autonomous movement, feeding, metabolism, combat, reproduction, mutation and death;
- inspect organisms and inherited traits;
- observe changing trait distributions and at least one calibrated case of stable ecological divergence;
- see automatically detected lineage/species splits and extinctions;
- inspect a tree of life and event timeline;
- alter climate, terrain and resources without directly controlling organisms;
- pause and run at 1×, 5×, 20×, 100× and MAX;
- save locally, reload, rewind deterministically and create a branch from history;
- run the simulation headlessly in automated tests.

## Technical baseline

- React + TypeScript for application UI.
- Vite for web build/tooling.
- PixiJS 8.x for 2D GPU rendering.
- Dedicated Web Worker for simulation execution.
- TypedArrays / Structure-of-Arrays for hot state.
- IndexedDB for local worlds.
- Capacitor later for iOS/Android.
- Vitest + Playwright for testing.
- No Rust/WASM until profiling proves it is needed.

## Primary technical references

- PixiJS 8 introduction: https://pixijs.com/8.x/guides/getting-started/intro
- PixiJS ParticleContainer: https://pixijs.com/8.x/guides/components/scene-objects/particle-container
- PixiJS performance: https://pixijs.com/8.x/guides/concepts/performance-tips
- Vite: https://vite.dev/guide/
- Capacitor: https://capacitorjs.com/docs/
- Capacitor PWA: https://capacitorjs.com/docs/web/progressive-web-apps
- MDN Web Workers: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
- MDN IndexedDB: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API

These references justify platform choices. Simulation rules in this package are project-specific, versioned design decisions and must not be treated as literal biological truth.

---

## Development

Prerequisites: Node 22 (`.nvmrc`) and pnpm 10.

```bash
pnpm install         # install locked dependencies
pnpm verify          # typecheck + lint + test + build (task A06)
pnpm test            # Vitest across all packages
pnpm headless --seed 0xE0A12026 --ticks 10000 --checkpoints 0,1,10,100,1000,10000
pnpm --filter @eon/web dev   # run the web shell locally
```

Current status: Milestones 0–3 complete — workspace, determinism skeleton (hardened after
review), the procedural environment, and organism mechanics. Milestone 4 (reproduction and
mutation) has not started, so the founder cohort can only shrink.

The simulation is real and inspectable headlessly:

```text
world      256x256 cells, generation attempt 0
land       61.2%  biomes Water=38.8% Grassland=48.0% Forest=0.0% Desert=5.6% Tundra=6.9% Mountain=0.7%
plants     capacity 168.8M, biomass 84.4M (50.0% of capacity)
founders   cell 40426 at (234, 157) in a 35507-cell landmass
organisms  256 spawned, entity IDs 1..256

tick      0 | pop  256 | mean energy   10023 | mean growth 0.45 | plant intake 0.0k | deaths 0
tick   1000 | pop  256 | mean energy   56108 | mean growth 0.98 | plant intake 27705.9k | deaths 0
tick   3000 | pop  250 | mean energy   53234 | mean growth 1.00 | plant intake 85104.4k | deaths 6 (starvation 6)
tick   6000 | pop  225 | mean energy   55493 | mean growth 1.00 | plant intake 169897.8k | deaths 31 (starvation 31)
tick  10000 | pop    0 | mean energy       0 | mean growth 0.00 | plant intake 0.0k | deaths 256 (starvation 31, oldAge 225)
```

The founders forage, grow to maturity on what they find, compete hard enough that some starve,
and — since nothing reproduces yet — die together of old age at their genetic maximum of 6100
ticks. Nothing about them is scripted: after spawn they run the same quantized network as any
descendant will.

Two configurations, deliberately separated (ADR 0002 §4):

- `SimulationConfig` (`@eon/engine`) — authoritative constants only. It is hashed into the
  world state hash, so anything in it defines world identity.
- `HostRuntimeConfig` (`@eon/protocol`) — wall-clock pacing, render and autosave cadence, LOD
  budget, the simulated-year display divisor. The pure engine never receives it, so changing a
  render rate cannot change a world hash.

The golden deterministic fixture lives in `packages/engine/src/fixtures/goldenStateHashes.json`;
regenerating it is only legitimate together with an `ENGINE_VERSION` bump and a `CHANGELOG.md`
entry (see `CLAUDE.md`). Current versions: engine 0.3.0, protocol 1, snapshot schema 4, config
schema 4. Design decisions are recorded in `docs/adr/`:

- `0001-milestone-0-1-implementation-decisions.md` — workspace, PRNG, trig LUT, hashing.
- `0002-milestone-1-hardening.md` — state encapsulation, config immutability, the
  authoritative/host config split and 64-bit-safe ticks.
- `0003-milestone-2-environment.md` — value noise, world generation and its calibration, plant
  growth, the founder region.
- `0004-milestone-3-organism-mechanics.md` — the organism SoA, gene mappings, sensors, the
  quantized brain, movement and feeding, and why the specified founder had to be recalibrated
  before it could eat.
