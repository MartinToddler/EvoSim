# Changelog

All notable changes to Project EON. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Golden-hash policy (CLAUDE.md): any intentional authoritative behavior change requires an
`ENGINE_VERSION` bump, regenerated golden hashes and an entry here. UI-only changes must never
alter engine hashes.

## [Unreleased] — 2026-08-14 — Milestone 8: species and history

Engine **0.5.0 → 0.6.0**, snapshot schema **6 → 7**, protocol **3 → 4**, config schema unchanged
(6). **Every golden hash regenerated** (10k fixture, both 100k soaks): the canonical stream gained
the species registry, the world event log and the event-detector state, and a new world now
carries a founder species record plus a `WorldCreated` event. The organism trajectory itself is
**unchanged from 0.5.0** — the fixture reproduces 0.5.0's population/generation/diet numbers
exactly (ADR 0013).

### Added

- **Species registry** (`evolution/SpeciesStore.ts`, docs/05 §5): permanent records with parent,
  origin/end ticks, end reason (active/split/extinct), live population maintained at every birth,
  death and split, lifetime birth/death/kill/intake accumulators, current + origin centroids and
  split-candidate state. IDs are dense, monotonic and never reused; parents always precede
  children, so the Tree of Life is acyclic by construction.
- **Deterministic speciation** (`evolution/speciation.ts`, phase 16, docs/05 §§6–7): a versioned
  fifteen-dimension normalized phenotype trait vector (hue and brain weights excluded), seeded
  deterministic 2-means with entity-ID tie-breaks, minimum daughter population, an RMS split
  threshold compared without division, and a five-interval stability requirement with A/B-swap
  centroid continuity and a reset-on-failure policy. One outlier cannot split; a temporary
  separation cannot accumulate. New validator rule: the split threshold must exceed twice the
  continuity threshold, or swap-matching could be ambiguous.
- **Extinction** (docs/05 §8): marked by death finalization at the exact tick a species empties,
  with the event emitted there; split parents are not extinct; records are permanent.
- **World event log** (`history/EventStore.ts`, docs/05 §§12–13): numeric-only records bounded by
  `limits.maxTimelineEventsInMemoryBeforeChunk` (oldest dropped and counted — detection never
  reads the log, so dropping cannot change future events). Event types: WorldCreated,
  SpeciesSplit, SpeciesExtinct, PopulationBoom/Crash, FirstPredation, CarnivoreLineageDetected,
  MassExtinction, PopulationCapReached (closing task E06), PlayerIntervention reserved for M9.
- **Deterministic event detection** (`history/eventDetection.ts`, phase 17, docs/05 §§14–17):
  first predation latched at the kill with attacker/victim/species/position; carnivore lineages
  from observed intake with a persistence streak and an adequate-observation floor; boom/crash
  against a rolling baseline with relative + absolute thresholds and a shared debounce; mass
  extinction over a non-overlapping window; population-cap events once per pressure episode.
  Detector state is authoritative: hashed, serialized, restored exactly.
- **Statistics store** (`history/StatisticsStore.ts`, docs/05 §§10–11): world samples every
  `statisticsInterval` ticks in three 10:1 tiers of 240 buckets (mean/sum/last per metric kind)
  and a frozen-on-end 120-sample ring per species — bounded memory forever. Serialized for
  reload continuity, deliberately NOT hashed (derived history; retention is presentation
  capacity), with byte-exact round-trip and continuous-vs-restored equality tests instead.
- **Protocol 4**: `QUERY_SPECIES` → `SPECIES_DETAILS`, `REQUEST_TREE` → `TREE_SNAPSHOT`,
  `REQUEST_HISTORY_RANGE` → `HISTORY_EVENTS`; telemetry gains species counts and
  `latestEventId` (the pull signal — no event push stream); display labels for event types,
  severities, end reasons and trait dimensions.
- **UI** (docs/06 §§12–14): species panel with living/ended list and a full inspector
  (status, lineage links, observed diet fractions, pending-split progress, population and trait
  charts, centroid bars with origin notches); Tree of Life as plain SVG with a year axis, zoom,
  native-scroll pan, status distinction beyond colour and click-to-inspect; history timeline
  with a severity-coded marker strip, filtering and expandable events. The top-bar species
  placeholder is now the live count; the organism inspector links to its species. Panel state
  generalized to five panels under the one-sheet mobile rule.
- **Tests**: 61 new across engine fixtures (single cloud never splits; two clouds split at
  exactly the fifth analysis; an outlier never splits; temporary separation resets; minimum
  daughter population; parent/daughter records; extinction; stable IDs across save/load;
  deterministic ties incl. a hand-built exact tie; pending-split snapshot/restore to an
  identical future; no duplicate events per detector; acyclic tree; species invariants swept
  through the 100k soak), statistics tiering/serialization, host round-trips and UI panels.
  Browser-verified end to end (15/15 headless-Chromium checks, zero console/page errors).

### Changed

- `finalizeDeaths` and `resolveCombatSimultaneously` take the current tick (extinction marking
  and first-predation capture need it).
- `TickPhase` gains `Statistics` (13); the species-analysis slot reserved since M6 is live.
- Golden hashes: fixture checkpoints, populated soak (`0c68f8d29c69c142`, ends with one species —
  evolved diversity is a continuous cloud, and the detector correctly refuses to split clouds)
  and lifeless environment soak (`3ec8fef25a0a3e86`).

## [Unreleased] — 2026-08-14 — Milestone 7 review: observation UI

Independent review of the observation UI (ADR 0012). All versions unchanged — engine 0.5.0,
protocol 3, field layout 2 — and **every golden hash untouched**: nothing under
`packages/engine`, `packages/protocol` or the Worker host moved. Verified statically, through the
fake-driven session tests, and in a scripted headless-Chromium pass (25/25 checks, zero console
and page errors).

### Fixed

- **A third finger during a pinch fired a click selection** (`EonRenderer`). Only exactly-two
  active pointers were treated as a pinch, so a steadying third finger became a zero-travel drag
  whose lift read as a tap — selecting or deselecting whatever it rested on, tearing down follow
  and retargeting the inspector mid-gesture. Two or more pointers are now always a pinch, and no
  finger of a pinch can end as a click.
- **A pinch that ended with one finger still down left that finger dead.** It now continues the
  gesture as a pan, with its click suppressed — the standard map-app behaviour.
- **Charts blocked the mobile stats sheet from scrolling.** `.chart-plot` demanded
  `touch-action: none`, and the chart grid is most of the sheet's touch surface; a vertical swipe
  starting on a chart went nowhere. Now `pan-y`: swipes scroll the sheet, horizontal movement
  still drives the hover crosshair.
- **Two bottom sheets could stack on a viewport that became narrow** with both panels open (a
  tablet rotating, a window shrinking) — the docs/06 §16 one-sheet rule was enforced only at
  toggle time. Panel visibility is one state object now, and the narrow-viewport media-query
  subscription settles the conflict on entry (stats stays, layers closes).
- **Speed tooltips hardcoded the default tick rates** instead of deriving them from
  `hostRuntime.targetTicksPerSecond1x`; a re-paced host would have advertised rates it never
  targets. Now computed from `SPEED_MULTIPLIER` and the runtime's real 1× rate (test-pinned
  against a non-default rate).
- **Layer radios carried `aria-pressed` alongside `role="radio"`** — the toggle-button attribute
  contradicts the radio role for assistive tech. They expose `aria-checked` alone, with the
  stylesheet highlighting either shape.
- **The seed-copy confirmation timer leaked**: a rapid second copy let the first timer cut the
  new confirmation short, and unmounting mid-confirmation left the timer firing afterwards. It is
  cleared on re-click and on unmount.

## [Unreleased] — 2026-08-14 — Milestone 7: Observation UI

Versions: `ENGINE_VERSION` **unchanged at 0.5.0**, `PROTOCOL_VERSION` 2 → **3**,
`FIELD_SNAPSHOT_LAYOUT_VERSION` 1 → **2**, everything else unchanged. **No golden hash changed**,
and the suite reproduced every one — this milestone is observation: projections got richer, no
authoritative rule moved. Decisions in `docs/adr/0011-milestone-7-observation-ui.md`.

### Added

- **World layers (H05).** The terrain snapshot grew four static byte-per-cell display planes —
  temperature, moisture, fertility, plant capacity (field layout 2) — written once with
  WORLD_READY by the extended `writeTerrainFields`. The renderer composes nine selectable views
  (terrain, biomes, elevation, temperature, moisture, fertility, plant biomass, plant capacity,
  organism density) from planes already on the main thread, blended over the composed terrain with
  an opacity control. Switching layers sends the Worker nothing — a session test counts posted
  messages to keep it that way. Density is derived from render snapshots only while its layer is
  active. Legend ranges (temperature span, capacity reference) are engine constants published via
  `WorldSummaryDto.display`, so the legend cannot disagree with the writer.
- **Global statistics and charts (H04).** `collectTelemetryAggregates` now also returns alive-
  population trait means (diet, top speed, adult radius, vision, attack, armor, metabolic pace,
  thermal optimum), total organism mass and mean energy fraction — still one ascending pass at
  telemetry cadence. `@eon/ui`'s `StatsHistory` accumulates the 2 Hz stream into the docs/05 §11
  multiresolution tiers: recent history raw, older history geometrically coarser, hard
  `bucketsPerTier × maxTiers` retention bound, whole run always on the chart. Hand-rolled SVG
  time-series charts (population, plant biomass, births/deaths per 1 000 ticks, mean diet with a
  zero reference, mean speed/vision/radius, mean energy) plot against the authoritative tick —
  never the sample index — with hover crosshairs and numeric summaries (docs/06 §17).
- **Full organism inspector (H03).** Overview, vitals with meters, inherited traits, running
  costs (basal upkeep with thermal multiplier, movement cost of the last tick's realized effort,
  thermal stress), a collapsible brain view — the last tick's 20 sensor inputs and 5 intents read
  from retained scratch, labelled from the world's own label list, never re-inferred and never a
  400-weight dump — plus lifetime tallies and surroundings. `EntityDetailsDto` gained the cost,
  brain and reproduction-cooldown fields.
- **Follow mode (H03).** The camera tracks the selected organism each frame; following ends
  explicitly — cleared, replaced by a new selection, taken back by a drag, or the target died —
  and the UI is told which. Death on a paused world (no further snapshots) is caught through the
  inspector's query path.
- **Top bar (H01/H02).** World name/seed with copy-to-clipboard, simulated year, tick, population
  with a cap-pressure warning driven by `capRejectedBirths` (docs/01 §11), a species placeholder
  that says why it is one (Milestone 8), plant biomass, generation, an honest run-state chip
  (Paused/Running/Max/Behind), measured TPS, play/pause and the 1×–100×/MAX speed buttons, and
  panel toggles.
- **Responsive layout (H06).** Desktop: layers panel left, inspector right, charts bottom, canvas
  dominant. Under 760 px the panels become bottom sheets and only one major sheet opens at a time
  (docs/06 §16); the stat strip scrolls sideways; Esc deselects; touch targets stay ≥44 px.
- **`@eon/ui` is real (docs/10 §1).** The M6 components moved out of `apps/web`; charts live in
  `packages/ui/src/charts/`. The package depends on `@eon/protocol` and the new pixi-free
  `@eon/renderer/palette` subpath only. React-hooks linting now covers it.

### Changed

- **DTOs are frozen at the session boundary.** `WorldSession` deep-freezes world summary,
  telemetry and entity details before React sees them, turning "the UI cannot mutate authoritative
  state" into a thrown `TypeError`. Tests assert frozenness end to end.
- **`WorldSession` grew test seams.** The Worker and renderer are injectable, so selection,
  stale-query dropping, follow lifecycles, layer isolation and teardown are unit-tested in Node
  with fakes; `workerPort` accepts a structural worker.
- **`WorldSummaryDto` carries a `display` block** (brain input/intent labels, death-cause labels,
  temperature display range, capacity reference) copied from engine constants by the host — the
  one module that imports both packages.
- **Telemetry additions:** `organismMass`, `meanEnergyFraction`, `traitMeans`.

### Known limitations

- Species count and save state are placeholders until Milestones 8 and 10.
- Charts begin at page load; there is no engine-side statistics history yet, so a reloaded world
  starts its charts fresh (`REQUEST_HISTORY_RANGE` remains future work, docs/02 §13).
- The Playwright suite is still task L08; this milestone was verified with a scripted manual
  browser pass (Chromium) recorded in the session notes.

## [Unreleased] — 2026-08-13 — Milestone 6: Worker host, render transport and PixiJS renderer

Versions: `ENGINE_VERSION` **unchanged at 0.5.0**, `CONFIG_SCHEMA_VERSION` unchanged (6),
`SNAPSHOT_SCHEMA_VERSION` unchanged (6), `PROTOCOL_VERSION` 1 → **2**,
`HOST_RUNTIME_CONFIG_SCHEMA_VERSION` 1 → **2**. **No golden hash changed**, and every one was
reproduced. That is the headline, not a footnote: this milestone is entirely projection and hosting,
and CLAUDE.md requires that a UI-only change never move an engine hash. Decisions in
`docs/adr/0010-milestone-6-worker-renderer.md`.

### Added

- **Worker message protocol (G01).** `protocol/messages.ts`: versioned main→worker and worker→main
  unions with `requestId` correlation for the two request/response pairs, and defensive decoding —
  `onmessage` receives `unknown`, so a malformed or stale-version message becomes an ERROR envelope
  instead of an exception thrown inside a handler where it would surface as an unattributable
  `ErrorEvent`. `protocol/dto.ts` carries the display DTOs: speeds, world summary, telemetry, entity
  details, worker errors.
- **Packed render transport (G04, G05).** `protocol/renderSnapshot.ts` and
  `protocol/terrainSnapshot.ts`: one `ArrayBuffer` per snapshot holding Structure-of-Arrays columns
  for organisms and carcasses, so a frame costs one transfer and one recycle rather than seventeen.
  Self-describing header — magic, layout version, capacities, counts and a `Float64` tick, because a
  tick has not fitted in `uint32` since engine 0.1.1. `RenderBufferPool` and `VegetationBufferPool`
  recycle a bounded set of buffers and refuse detached, foreign or wrong-shaped ones.
- **Simulation Worker host (G02, G03).** `apps/web/src/worker/SimulationHost.ts`: one engine, one
  scheduler, one loop. Clock, scheduler and message port are injected, so pause races, catch-up
  bursts, MAX yielding and buffer lifecycle are unit-testable in Node against a fake clock.
  `simulation.worker.ts` supplies `performance.now`, `setTimeout` and `postMessage` and nothing else.
- **Engine render projections (G04, G09).** `engine/render/renderSnapshot.ts` and
  `engine/render/queryEntity.ts`: pure readers that fill caller-owned TypedArrays or return one
  organism's details in human units. No allocation, no tick, no PRNG, no writes. The writer parameter
  is a structural interface, so the engine does not import the protocol and the protocol does not
  import the engine.
- **Tick phase profiling (CLAUDE.md "Profiling").** `engine/profiling/TickProfiler.ts`: the engine
  reports phase boundaries to an injected profiler and still never reads a clock. A profiler receives
  two integers and returns nothing, so there is no channel from a clock reading into authoritative
  state — asserted by running a profiled world beside an unprofiled one.
- **PixiJS renderer (G05–G10).** `@eon/renderer`: terrain as a 256² data texture recomposed when
  vegetation arrives, `ParticleContainer` layers for organisms and carcasses created once and updated
  in place, a pooled detail layer above a screen-size threshold, a screen-space selection ring, a
  camera with pointer-anchored zoom and pinch support, and an environment-grid debug overlay. Depends
  on `@eon/protocol` alone — there is no import path from the renderer to the engine.
- **Application shell.** Top bar with seed, simulated year, tick, population, carcasses, plant
  biomass, generation and measured TPS; play/pause and 1×/5×/20×/100×/MAX; fit and grid toggles; a
  selected-organism readout. React holds world metadata, 2 Hz telemetry and the selected entity —
  never an organism coordinate.
- **`deploy-pages.yml`.** Builds and publishes `apps/web/dist` to GitHub Pages, gated on typecheck
  and lint. Live at **https://martintoddler.github.io/EvoSim/**.
- **`pnpm equivalence`** (`scripts/workerEquivalence.ts`). Drives the Worker host through an erratic
  schedule on the real default world and compares the result against a plain `stepMany` and against
  the committed golden hash. At tick 10 000, with 9 820 of the ticks produced by the scheduler
  itself, all three agree on `f58bac3bde3256f3`.

### Changed

- **`PROTOCOL_VERSION` 1 → 2.** Version 1 was an envelope type with no message union and no consumer;
  this is the first version an actual Worker speaks.
- **`HostRuntimeConfig` schema 1 → 2**, adding `vegetationSnapshotsPerSecond`,
  `telemetrySnapshotsPerSecond`, `maxCatchUpTicks`, `maxTicksPerSlice` and `renderBufferPoolSize`.
  None of it is authoritative, which is exactly why it lives in `@eon/protocol` — a render cadence
  must never move a world hash (ADR 0002 §4).
- **`SimulationEngine.step()`** now calls optional profiler hooks at phase boundaries, and
  `setProfiler` attaches or detaches one. Behaviour and hashes are unchanged.
- **Vite `base` is a build-time environment variable** (`EON_BASE_PATH`), because the same bundle must
  serve from `/` under `vite dev` and from `/<repo>/` on a project site. A wrong base is silent at
  build time and fatal at run time — every asset, the Worker included, 404s.

### Fixed

- **CI had not verified anything since Milestone 4.** The `verify` job's
  `timeout-minutes: 20` is shorter than the test suite, which the 100 000-tick soaks pushed past
  twenty minutes when evolution landed. Runs 8 through 13 were all cancelled at 20m20s, and a
  cancelled run reads as "not green" rather than "failed", which is how it went unnoticed for five
  milestones — the `determinism` matrix never ran at all, because `needs: verify` gated it behind
  the cancelled job. Both budgets are now 60 minutes and documented as hang detectors, not
  performance assertions (docs/07 §8). The long-term lever is still scheduling the soaks separately
  rather than shortening them (ADR 0006 §9). The cross-platform `determinism` matrix is now gated to
  the default branch and manual runs: it is the most expensive thing in the repository — the engine
  suite three times, with macOS billed at 10x minutes and Windows at 2x — so raising the timeout
  would otherwise have switched ~200 billed minutes per push on for every branch at once. The branch
  is read from the event payload rather than hard-coded, so the gate survives a rename.
- **`?seed=` accepted malformed values as real worlds.** `Number.parseInt` reads `"0x"` as 0 and
  `"12abc"` as 12, so a typo in a shared link opened a _different_ world instead of the default one.
  The shape is now validated before parsing.

### Known limitations

- **Deployment required two one-off repository settings.** No workflow token can enable Pages
  (repository-administration scope, which `GITHUB_TOKEN` cannot hold), and once enabled the
  `github-pages` environment restricts deployments to the default branch, so deploying a feature
  branch is rejected in one second with an empty log. Both settled: the repository is public and the
  environment has no branch restriction. Live at
  **https://martintoddler.github.io/EvoSim/**.
- **No Playwright suite (L08).** The browser verification for this milestone was run ad-hoc against
  a real Chromium; wiring Playwright into the repository is section L work.
- **No viewport culling.** Every live organism is updated and submitted each frame. At the 8 192 cap
  that is not a measured hotspot, and CLAUDE.md says to optimize measured hotspots only.

## [Unreleased] — 2026-08-13 — Milestone 5: predation, carrion and combat

Versions: `ENGINE_VERSION` 0.4.0 → **0.5.0**, `CONFIG_SCHEMA_VERSION` 5 → **6**,
`SNAPSHOT_SCHEMA_VERSION` 5 → **6**, `PROTOCOL_VERSION` unchanged (1). **Every golden hash was
regenerated** — the six fixture checkpoints, the config digest `2d2712ccf817a700` and both soak
hashes. Two independent causes: the carcass store joined the canonical hash stream, and the carcass
sensors stopped reporting a pinned absence. The hashes therefore move from tick 0, while the
reference world's _behaviour_ is bit-identical to 0.4.0 until its first death — population 256,
births 256, deaths 0 and trait variance 0 at tick 1 000 on both — and diverges only once a body
exists for something to sense (ADR 0008 §5). The mutation fixture's genes, brain digest and PRNG
state are **unchanged**; only its version stamps moved. Decisions, measurements and two calibration
findings in `docs/adr/0008-milestone-5-predation.md`.

Built on the Milestone 3/4 line (`734b50b`), whose six golden hashes were re-verified in a pristine
worktree before any code was written. The foundation-gate and Milestone 2.5 branches remain
unmerged; ADR 0006 §0's recommendation to merge them before Milestone 9 stands.

### Added

- **Carcasses (F01).** `ecology/CarcassStore.ts`: Structure-of-Arrays carrion with a LIFO free
  stack, cleared rows, hashed and serialized in full, carrying the dead organism's entity ID rather
  than a new identity. Every death leaves a body — starvation, old age, drowning, thermal stress and
  combat alike — created in phase 13 before the organism's slot is released. At the
  `limits.maxCarcasses` cap the carcass is deterministically skipped and counted in `skippedAtCap`,
  never swapped for an existing one (docs/10 §14).
- **Deterministic decay (F01), phase 15.** `base × (1 + hotBonus)` per decay step, where the bonus
  ramps from zero at `hotDecayMinTemperatureCentiC` to `hotDecayBonusMaxQ` at
  `hotDecayFullBonusTemperatureCentiC`. A `MIN_CARCASS_DECAY_UNITS = 1` floor makes decay strictly
  monotone and guarantees termination — without it a carcass under 205 units would lose nothing
  forever at the default rate — and it deliberately does not fire when the configured rate is zero,
  so the "carrion never rots" ablation still works.
- **Carcass sensing (F02).** `CarcassProximity`/`CarcassForward`/`CarcassLateral` now report real
  carrion, found through a dedicated carcass spatial index with the observer's own vision range and
  field of view, ties on lower squared distance then lower entity ID. Absence stays −Q, not 0: the
  edge of vision reads −Q, so a zero would rank above a distant sighting.
- **Carcass feeding (F02) and the diet trade-off (F03).** Meat is allocated by the same
  aggregate-then-share rule as plant biomass, with the integer remainder going to the lowest entity
  IDs. Energy is `units × meatEnergyPerUnit × meatEfficiency`, where the efficiency comes from the
  single signed diet gene. The docs/04 §20 target policy is implemented verbatim and documented at
  the call site: a carcass in mouth range wins only when meat digests at least as well as plants, so
  a herbivore ignores carrion it is standing on.
- **Combat (F04–F07), phases 10 and 11.** Attack intent over threshold, contact validated as
  touching bodies, energy charged before the blow, cooldown, damage accumulated across all attackers
  and applied simultaneously, armor mitigation, impact bonus from realized speed, and kill
  attribution to the largest contributor with ties on the lower attacker entity ID. Mutual kills are
  possible by construction: nothing dies inside the attacker loop.
- **Three config fields** (§3 of the ADR): `organism.carcass.hotDecayMinTemperatureCentiC`,
  `organism.carcass.hotDecayFullBonusTemperatureCentiC` and `combat.attackSizeFactorFloorQ`. Each
  closes a place where docs/08 gives a magnitude without the scale to read it against. Contact range
  and mouth range deliberately stay geometric — summed body radii and the eater's own radius — rather
  than becoming tunable constants with no observable meaning.
- **78 tests** across `ecology/CarcassStore.test.ts`, `ecology/carcasses.test.ts`,
  `ecology/combatClaims.test.ts`, `ecology/carcassFeeding.test.ts`, `brain/carcassSensors.test.ts`
  and `predationSimulation.test.ts`. The acceptance fixtures drive the real `SimulationEngine.step()`:
  a handcrafted hunter detects, closes, wounds, kills, is credited the kill and then scavenges the
  carcass; two evenly matched fighters kill each other on one tick; and a controlled diet experiment
  with mutation switched off shows the matching specialist winning realized reproductive success in a
  plant world and in a meat world.
- **Predation in the headless report and the sweep.** `pnpm headless` now prints live carcasses,
  carcasses skipped at the cap, meat created and eaten, meat intake, kills and the population's mean
  diet — the only way to see whether a world has discovered carnivory. `pnpm sweep` reports the same
  observables per seed plus "seeds eating meat" and "seeds hitting the carcass cap" in its summary,
  because both calibration findings below are questions about seeds rather than about one world.

### Changed

- **`lastDamageQ` now includes combat damage.** Combat lands in phase 11 and starvation/thermal
  damage in phase 12; the physiology phase seeds its accumulator from what combat applied instead of
  overwriting it, so the field means what its name says.
- **`SpatialGrid.rebuild` grew a generic `rebuildFrom`** over an occupancy + position triple, so
  carcasses reuse the organism grid implementation instead of getting a second one.
- **`FOV_COS_SCALE` moved to `spatial/fov.ts`.** The carcass queries need the phenotype's body
  radius while the phenotype cache needs the FOV scale, which would have made those two modules
  import each other.
- **`totalAllocatedBiomass` is filtered by food kind** and joined by `totalAllocatedMeat`: biomass
  units and meat units are different quantities, and one total over both would be meaningless.
- **The 100 000-tick soak's hang detector rose from 1 800 000 ms to 5 400 000 ms.** Carrion sensing
  scales with population x carcass density and this world packs up to 4 096 carcasses into 2 304
  spatial cells, so the soak went from ~350 s to ~1 810 s standalone (1 881 s inside the parallel
  suite) and tripped the old budget. It is a hang detector, not a performance assertion — docs/07 §8
  forbids enforcing an arbitrary CI wall clock, which is the same rule ADR 0007 §1 had to restate —
  and the measurements now sit next to the number. `pnpm test` costs ~1 880 s wall against ~940 s at
  0.4.0, dominated by that one file. No assertion was removed or weakened; the soak's carcass
  invariants were _added_ in this milestone.

### Calibration findings (not fixed — input for L07)

- **No meat was eaten in 10 000 ticks of the reference world.** The founder lineage is
  herbivore-leaning (mean diet −0.597 against a −0.600 start), so under the docs/04 §20 policy no
  organism ever prefers a body. The mechanism is proven by fixture and by controlled experiment;
  whether carnivory is reachable _in practice_ on the default constants is a calibration question,
  and docs/07 §12 lists "carnivory impossible" as a failure mode to monitor rather than to patch.
- **The carcass cap saturates.** 4 096 live carcasses and 4 751 skipped by tick 10 000: at the
  documented decay rate a carcass survives roughly 8 000 ticks, so a world losing about one organism
  per tick accumulates toward twice `maxCarcasses`. Behaviour at the cap is correct by specification,
  and `skippedAtCap` is hashed so the loss is visible, but it suppresses exactly the carrion supply
  this milestone exists to create. Linked to ADR 0006 §7's population-cap finding: fewer deaths per
  tick would relieve both.
- A second-order effect worth knowing: carrion made herbivores eat **more**. The founder's +0.40
  `carcassProximity` weight on the eat output (docs/08 §20) was a permanent −0.40 tax while no
  carcass could exist, and is now a real bonus — so a nearby body raises the drive to graze.
  Starvation deaths fell and the population at tick 10 000 came out at 4 364 against 4 718.

## [Unreleased] — 2026-08-13 — Milestone 5 review: predation, carrion and combat

Versions: **all unchanged** (`ENGINE_VERSION` 0.5.0, `CONFIG_SCHEMA_VERSION` 6,
`SNAPSHOT_SCHEMA_VERSION` 6, `PROTOCOL_VERSION` 1). **No golden hash moved** — the six fixture
checkpoints, the config digest `2d2712ccf817a700` and both 100 000-tick soak hashes are unchanged
and reproduced, which is the check that the fix below touched no authoritative behaviour. Full
risk-by-risk review, including what was examined and found clean, in
`docs/adr/0009-milestone-5-review.md`.

### Fixed

- **Carcass meat above 2³²−1 was silently truncated into its storage row, breaking meat
  conservation.** `CarcassStore.remainingMeat` is a `Uint32Array` while `totalMeatCreated` is a
  plain safe integer, and `organism.carcass.meatPerMass` was validated only as a non-negative
  integer with no upper bound. A configuration the validator **accepted** therefore produced a body
  worth 6 075 000 948 meat units, stored 1 780 033 652, and added the full amount to the counter —
  conjuring 4 294 967 296 units into `created == eaten + decayed + Σ remaining`, the invariant ADR
  0008 §2 names as this milestone's replacement for energy conservation. It broke silently in a way
  none of the invariant's own tests could detect, because all three levels of assertion read the
  counter. Same class as the Uint16 cooldown wrap ADR 0007 §2 fixed, and fixed the same way:
  `validateConfig` now computes the largest body a configuration can grow — mirroring
  `carcassMeatUnits` at full development, energy term included — and rejects any config whose
  worst-case carcass would not fit the row, while `CarcassStore.create` asserts the bound at the
  storage boundary so it can never happen silently if some future path bypasses the validator. The
  bound does not constrain tuning: the default is 3 and 1 000 000 still validates. Not reachable
  from `DEFAULT_CONFIG`, hence no version bump and no hash change.

### Changed

- **The kill-attribution tie-break is now pinned by a test that could fail.** The existing test
  spawned its two attackers in entity-ID order, which is also slot order until something dies and
  its slot is reused — exactly the situation the tie-break exists for — so it would have passed
  against an implementation that simply kept the first attacker it iterated over. Target selection
  had no tie-break test at all. The implementation was correct; three tests were added that free a
  slot, hand it to the _later-born_ organism, and assert the winner is the one at the **higher**
  slot: attribution on equal damage, target choice between equidistant bodies, and that a released
  slot left in a stale index is neither targeted nor charged for.
- **Snapshot/restore is now verified at every tick of a live combat window** rather than at a single
  tick, since a save's tick decides whether it catches a counting-down cooldown, a filed claim, a
  carcass created by phase 13 or a slot returned to the free list by phase 9 or 15. Each save is
  resumed to a common horizon and compared at every tick — the method ADR 0007 used for
  reproduction, applied to the state this milestone introduced.
- `findCarcassInMouthRange`'s doc comment claimed to read "the POST-movement index"; it reads the
  phase-2 carcass index, and no post-movement carcass index exists. The behaviour was right — a
  carcass never moves and the eater's position is read live — but the comment stated a false premise
  in the one file whose correctness argument is about which index is read when.

### Known limits

- Accumulated combat damage (`scratch.damageAccumQ`, an `Int32Array`) could wrap at roughly
  `combat.baseAttackDamageQ > 49 × Q` with ~8 000 bodies in one contact pile, and a wrapped negative
  total would be skipped by the `damage <= 0` guard. Documented rather than fixed (ADR 0009 §2):
  health is capped at `Q`, so `baseAttackDamageQ = Q` already one-shots any organism, and reaching
  the overflow needs a constant ~49× beyond instantly lethal. Unlike the meat bound, no principled
  ceiling exists for a field docs/08 leaves open.

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
