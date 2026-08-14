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
pnpm equivalence --ticks 10000   # Worker-scheduled vs headless vs golden hash (Milestone 6)
pnpm --filter @eon/web dev   # run the web app locally
```

Current status: Milestones 0–8 complete — workspace, determinism skeleton (hardened after
review), the procedural environment, organism mechanics (reviewed and hardened, ADR 0005), asexual
reproduction with gene and brain mutation (ADR 0006, reviewed in ADR 0007), predation: carrion,
combat and the diet trade-off (ADR 0008, reviewed in ADR 0009), the Worker host, render
transport and PixiJS renderer (ADR 0010), the observation UI (ADR 0011, reviewed in ADR 0012),
and species + history (ADR 0013): a deterministic species registry, seeded 2-means bifurcation
detection with five-interval stability, extinction and lineage records, a bounded world event
log with eight deterministic detectors, tiered statistics, and the Tree of Life / species
inspector / history timeline views (engine 0.6.0, snapshot schema 7, protocol 4).

**The world is now watchable and legible — live at <https://martintoddler.github.io/EvoSim/>.**
Locally, `pnpm --filter @eon/web dev` opens a canvas showing the terrain,
the plants, and the organisms living in it — pan, zoom, run at 1×, 5×, 20×, 100× or MAX. Click an
organism for the full inspector (vitals, inherited traits, running costs, the last tick's brain
inputs and intents) and follow it as it lives; open the stats panel for bounded-memory charts of
population, biomass, birth/death rates and trait drift; flip the world through nine data layers
(biomes, elevation, temperature, moisture, fertility, plant biomass and capacity, organism
density) without the simulation noticing; open the species panel, the Tree of Life and the
history timeline to watch detected lineages, splits, extinctions, booms, crashes and the world's
first predation appear as events. The simulation itself runs in a dedicated Worker and rendering
never decides anything — the Milestone 8 hash changes are the species/history state itself
joining the canonical stream, while the organism trajectory reproduces 0.5.0's exactly.

Everything below is still reproducible headlessly, which is the point — the same world, the same
hashes, with or without a browser.

The simulation is real and evolving:

```text
world      256x256 cells, generation attempt 0
land       61.2%  biomes Water=38.8% Grassland=48.0% Forest=0.0% Desert=5.6% Tundra=6.9% Mountain=0.7%
plants     capacity 168.8M, biomass 84.4M (50.0% of capacity)
founders   cell 40426 at (234, 157) in a 35507-cell landmass
organisms  256 spawned, entity IDs 1..256

tick      0 | pop  256 | gen 0 | births   256 | deaths    0 | var      0 | carcasses    0
tick   1000 | pop  256 | gen 0 | births   256 | deaths    0 | var      0 | carcasses    0
tick   2000 | pop 1506 | gen 1 | births  1525 | deaths   19 | var  51257 | carcasses   19
tick   5000 | pop 1164 | gen 4 | births  4353 | deaths 3189 | var 511118 | carcasses 3189
tick  10000 | pop 4364 | gen 8 | births 13212 | deaths 8848 | var 777110 | carcasses 4096 (4751 skipped)
```

The founders forage, grow to maturity on what they find, compete hard enough that some starve, and
from tick ~1120 they reproduce. Nothing about them is scripted: after spawn they run the same
quantized network as any descendant will, and `var` — the summed variance of the 15 ecological
genes, hue excluded — starts at exactly **zero**, because every founder is genetically identical.
All of it comes from mutation.

Predation is available but not scripted anywhere. There is no `Predator` type and no rule that reads
one: a hunter is an `attackPower` gene, an `attack` brain output, a carnivore `diet` gene and a
controller that steers at what it senses. A handcrafted predator in
`packages/engine/src/predationSimulation.test.ts` detects a prey animal, closes the distance, kills
it, is credited the kill and then eats the carcass — all through the ordinary tick loop.

**Three known calibration issues**, all deliberately left untuned because docs/08 §24 requires the
defaults to be implemented faithfully first and docs/07 §14 requires 10–30 seeds before a tuning
conclusion. All three are input for task **L07**, and `pnpm sweep` is the harness.

1. **The world's carrying capacity is far above the 8 192 organism safety cap.** Across six seeds at
   10 000 ticks all six survive, but **three are pinned at the cap** with 5.5–6.1 million refused
   births, and their trait diversity is about half that of the uncapped seeds — the cap is filtering
   by storage order instead of by ecology, exactly the bias docs/01 §11 warns about. docs/01 §12 makes
   not slamming the cap an MVP release gate, so this is on the critical path. Full table in ADR 0006 §7.
2. **No meat is eaten in 10 000 ticks of the reference world.** The founder lineage is
   herbivore-leaning (mean diet −0.597 from a −0.600 start) and docs/04 §20 only sends an organism to
   a carcass when meat digests at least as well as plants, so carnivory is reachable but not reached
   on this seed at this horizon. docs/07 §12 lists "carnivory impossible" as a failure mode to
   monitor. ADR 0008 §5a.
3. **The carcass cap saturates**: 4 096 live and 4 751 skipped by tick 10 000. At the documented decay
   rate a carcass survives roughly 8 000 ticks, so a world losing about one organism per tick
   accumulates toward twice `limits.maxCarcasses`. The behaviour at the cap is correct — a
   deterministic skip plus a hashed diagnostics counter, never an eviction — but it suppresses the
   carrion supply predation depends on. ADR 0008 §5b.

Two configurations, deliberately separated (ADR 0002 §4):

- `SimulationConfig` (`@eon/engine`) — authoritative constants only. It is hashed into the
  world state hash, so anything in it defines world identity.
- `HostRuntimeConfig` (`@eon/protocol`) — wall-clock pacing, render, vegetation, telemetry and
  autosave cadence, the scheduler's catch-up and slice bounds, the render buffer pool size, the LOD
  budget, the simulated-year display divisor. The pure engine never receives it, so changing a
  render rate cannot change a world hash.

The golden deterministic fixture lives in `packages/engine/src/fixtures/goldenStateHashes.json`;
regenerating it is only legitimate together with an `ENGINE_VERSION` bump and a `CHANGELOG.md`
entry (see `CLAUDE.md`). Current versions: engine 0.5.0, protocol 3, snapshot schema 6, config
schema 6, host runtime schema 2. Design decisions are recorded in `docs/adr/`:

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
- `0007-milestone-4-review.md` — the independent Milestone 4 review: a test wall clock that failed
  `pnpm verify` without any hash being wrong, a cooldown that wrapped silently in its Uint16 row, and
  the measurements behind the eight risks that turned out clean — including a repeated 100 000-tick
  same-seed comparison and save/load restored at every tick of a window.

- `0008-milestone-5-predation.md` — carrion, combat and the diet trade-off: why meat conservation is
  the invariant that replaces energy conservation, why contact and mouth range stay geometric instead
  of becoming config, why the attack cooldown is decremented in a different phase from the
  reproduction one, and two calibration findings — that nothing ate meat in 10 000 ticks and that the
  carcass cap saturates.
- `0010-milestone-6-worker-renderer.md` — the Worker host, render transport and PixiJS renderer:
  why the scheduler takes its clock as a constructor argument, why a render snapshot is one buffer
  and one transfer, why render snapshots are droppable and ticks are not, how the engine is profiled
  without ever reading a clock, and why the selection ring is drawn in screen space.
- `0011-milestone-7-observation-ui.md` — the observation UI: why the world layers ride the terrain
  snapshot instead of a new request protocol, the tiered chart history and the head-collapse bug the
  bounding test caught, running costs recomputed read-only and a brain view that is read rather than
  re-inferred, DTOs frozen at the session boundary, and the placeholders that refuse to lie.
- `0009-milestone-5-review.md` — the independent Milestone 5 review: a carcass meat value that
  silently wrapped its Uint32 row and conjured 4.3 billion units into the conservation identity, a
  kill-attribution tie-break test that could not have failed because slot order and entity-ID order
  agreed in it, and the twenty-three risks that were examined and found clean — including a 600-tick
  same-seed comparison and save/load restored at every tick of a live combat window.
- `0013-milestone-8-species-history.md` — species and history: the phenotype-space trait vector,
  deterministic 2-means with the swap-unambiguity validator rule, extinction at the death tick,
  one-emission-site-per-fact event detection, the hashed/derived statistics split, protocol 4's
  pull-based UI, and what 100 000 ticks of real evolution says about splitting clouds.
- `0014-milestone-8-review.md` — the independent Milestone 8 review: the twenty-one-point audit,
  the validator-accepted degenerate range that crashed construction (now a constant dimension),
  and the zero-pass candidate save/load assertion.
- `0012-milestone-7-review.md` — the independent Milestone 7 review: a third finger during a pinch
  that fired a click selection, a pinch that left its surviving finger dead, charts that blocked
  the mobile sheet from scrolling, a one-sheet rule that did not survive rotating to narrow, and
  the eighteen review dimensions that came back clean — verified statically, through the
  fake-driven session tests, and in a scripted headless-Chromium pass.

> **Repository note.** Three branches diverged in parallel from the Milestone 2 commit. This line is
> Milestone 2 → 3 → 4 → 5. The Milestone 0–2 "foundation gate" branch
> (`claude/evosim-project-setup-ps3fry`) and the Milestone 2.5 debug web view
> (`claude/m2-5-review-visualizer-54i8qn`) are **not merged here**. ADR 0006 §0 explains why that
> was safe for Milestone 4, ADR 0008 §0 re-checks it for Milestone 5, and the foundation-gate merge
> still has to happen before Milestone 9.
