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
pnpm sweep --seeds 0xE0A12026,1,2 --ticks 20000   # multi-seed calibration report (task E08)
pnpm --filter @eon/web dev   # run the web shell locally
```

Current status: Milestones 0–4 complete — workspace, determinism skeleton (hardened after
review), the procedural environment, organism mechanics (reviewed and hardened, ADR 0005) and
asexual reproduction with gene and brain mutation (ADR 0006). There is no renderer yet;
everything below is headless.

The simulation is real and evolving:

```text
world      256x256 cells, generation attempt 0
land       61.2%  biomes Water=38.8% Grassland=48.0% Forest=0.0% Desert=5.6% Tundra=6.9% Mountain=0.7%
plants     capacity 168.8M, biomass 84.4M (50.0% of capacity)
founders   cell 40426 at (234, 157) in a 35507-cell landmass
organisms  256 spawned, entity IDs 1..256

tick      0 | pop  256 | gen   0 | births    256 | deaths      0 | var       0
tick   1000 | pop  256 | gen   0 | births    256 | deaths      0 | var       0
tick   2000 | pop 1503 | gen   1 | births   1525 | deaths     22 | var   35283
tick   5000 | pop 1700 | gen   4 | births   4533 | deaths   2833 | var  111889
tick  10000 | pop 4718 | gen   8 | births  15408 | deaths  10690 | var  225530
```

The founders forage, grow to maturity on what they find, compete hard enough that some starve, and
from tick ~1120 they reproduce. Nothing about them is scripted: after spawn they run the same
quantized network as any descendant will, and `var` — the summed variance of the 15 ecological
genes, hue excluded — starts at exactly **zero**, because every founder is genetically identical.
All of it comes from mutation.

**Known calibration issue.** The world's carrying capacity is far above the 8 192 organism safety
cap. Across six seeds at 10 000 ticks all six survive, but **three are pinned at the cap** with
5.5–6.1 million refused births, and their trait diversity is about half that of the uncapped seeds —
the cap is filtering by storage order instead of by ecology, exactly the bias docs/01 §11 warns
about. docs/01 §12 makes not slamming the cap an MVP release gate, so this is on the critical path.
The defaults were nevertheless implemented faithfully and deliberately **not** tuned, because
docs/08 §24 requires that order and docs/07 §14 requires 10–30 seeds before any tuning conclusion.
It is input for task L07, and `pnpm sweep` is the harness. Full table in ADR 0006 §7.

Two configurations, deliberately separated (ADR 0002 §4):

- `SimulationConfig` (`@eon/engine`) — authoritative constants only. It is hashed into the
  world state hash, so anything in it defines world identity.
- `HostRuntimeConfig` (`@eon/protocol`) — wall-clock pacing, render and autosave cadence, LOD
  budget, the simulated-year display divisor. The pure engine never receives it, so changing a
  render rate cannot change a world hash.

The golden deterministic fixture lives in `packages/engine/src/fixtures/goldenStateHashes.json`;
regenerating it is only legitimate together with an `ENGINE_VERSION` bump and a `CHANGELOG.md`
entry (see `CLAUDE.md`). Current versions: engine 0.4.0, protocol 1, snapshot schema 5, config
schema 5. Design decisions are recorded in `docs/adr/`:

- `0001-milestone-0-1-implementation-decisions.md` — workspace, PRNG, trig LUT, hashing.
- `0002-milestone-1-hardening.md` — state encapsulation, config immutability, the
  authoritative/host config split and 64-bit-safe ticks.
- `0003-milestone-2-environment.md` — value noise, world generation and its calibration, plant
  growth, the founder region.
- `0004-milestone-3-organism-mechanics.md` — the organism SoA, gene mappings, sensors, the
  quantized brain, movement and feeding, and why the specified founder had to be recalibrated
  before it could eat.
- `0005-milestone-3-review-fixes.md` — the independent Milestone 3 review: the coincident-body
  separation order bug, two slot-bookkeeping defects, and the determinism, conservation,
  allocation and performance checks that the milestone passed.
- `0006-milestone-4-evolution.md` — asexual reproduction and mutation: the one-roll mutation
  partition, why over-investment destroys energy instead of being refunded, why reproduction runs in
  two passes, the population-cap calibration finding, and which foundation branch this line is
  built on.

> **Repository note.** Three branches diverged in parallel from the Milestone 2 commit. This line is
> Milestone 2 → 3 → 4. The Milestone 0–2 "foundation gate" branch
> (`claude/evosim-project-setup-ps3fry`) and the Milestone 2.5 debug web view
> (`claude/m2-5-review-visualizer-54i8qn`) are **not merged here**. ADR 0006 §0 explains why that
> was safe for Milestone 4 and why the foundation-gate merge has to happen before Milestone 9.
