# 07 — Testing, Performance, Calibration and Implementation Roadmap

## PART A — TESTING

## 1. Four layers

1. algorithm unit tests;
2. deterministic regression;
3. ecological invariant/selection tests;
4. browser UX/performance tests.

Do not assert brittle spontaneous evolutionary stories at fixed ticks.

## 2. Unit suites

### Fixed math

- Q multiply/divide;
- clamp;
- direction LUT;
- squared distance;
- brush falloff.

### PRNG

- exact sequence vector;
- save/restore;
- bounds;
- approx-normal stable sequence.

### World

- same seed identical hash;
- validity;
- biomes/thresholds;
- plant capacity.

### Plants

- growth below capacity;
- no invalid overflow;
- zero seed-bank recovery;
- proportional claim conservation/remainder.

### Genome

- mappings bounds;
- exact copy;
- deterministic mutation;
- clamp;
- founder hash.

### Brain

- known inference vector;
- clipping;
- output map;
- mutation.

### Movement

- exact fixed step;
- armor penalty;
- water;
- boundary.

### Combat

- simultaneous mutual attack;
- armor mitigation;
- kill attribution;
- energy cost;
- out-of-range no-hit.

### Reproduction

- maturity/development;
- energy conservation;
- child generation/parent;
- mutation;
- cap guard.

### Death/carcass

- causes;
- meat amount;
- decay;
- deterministic slot reuse.

### Species

- synthetic split;
- one outlier does not split;
- stability;
- two children;
- extinction.

### Snapshot

- round trip;
- PRNG continuation;
- checksum;
- incompatible version reject.

## 3. Golden deterministic fixture

```text
seed 0xE0A12026
default config
known founder
fixed command log
```

Hashes at:

```text
0
1
10
100
1000
10000
```

Additional:

```text
continuous 10k == save/load at 2.5k then continue
branch at 5k with no new commands == control 10k
```

## 4. Development invariants

Debug assertions:

- energy >=0;
- health valid;
- live slot ID nonzero;
- unique live IDs;
- positions in bounds;
- species population matches members;
- biomass sane;
- carcass meat >=0;
- free slot not alive.

Disable expensive checks in release.

## 5. Controlled ecological tests

### Founder viability

Approved seed suite survives meaningful startup.

### Resource depletion/regrowth

Hungry organisms lower biomass; removal of pressure allows recovery.

### Thermal selection

Two predefined genotypes differing primarily in thermal adaptation placed in controlled cold/hot environment. Expected genotype gains realized reproductive share.

### Diet selection

Plant-only test rewards herbivore specialist; meat-rich test rewards carnivore specialist, all else equivalent.

### Predator mechanics

Handcrafted predator and prey validate detection, attack, death and meat ingestion. This does not guarantee spontaneous carnivory.

## 6. Soak tests

100k ticks routine development.

1M ticks nightly/manual before release.

Check:

- no invalid numbers;
- no count corruption;
- no ID collision;
- no dead-entity leak;
- snapshot round trips;
- repeat hash deterministic.

## PART B — PERFORMANCE

## 7. Targets

Desktop design:

- 5,000 organisms;
- 256² environment;
- 20 TPS at 1×;
- 60 FPS renderer where hardware allows.

Mobile design:

- 2,000–3,000 comfortably rendered;
- same simulation rules;
- 30–60 FPS depending device.

Hard authoritative population cap does not change by device.

## 8. Initial budgets

At 5k organisms modern desktop:

- mean tick ideally <25ms;
- must be <50ms to sustain 20 TPS;
- render snapshot generation target <5ms at ~15Hz;
- main render average <16.7ms target for 60FPS.

Do not enforce arbitrary CI wall-clock on unknown hardware; record benchmarks.

## 9. Benchmark CLI

Create:

```bash
pnpm benchmark:engine --seed 123 --population 5000 --ticks 10000
```

Report:

- version;
- runtime/hardware metadata;
- ticks/s;
- mean/p50/p95 tick;
- phase totals;
- peak population;
- final hash;
- estimated memory.

## 10. Optimization order

1. profile;
2. remove allocations;
3. spatial queries;
4. cache derived traits;
5. sensor work;
6. brain frequency only if necessary and versioned;
7. render packing;
8. LOD/culling;
9. then consider WASM.

## 11. Memory watch

Measure approximate bytes for:

- organism state;
- 400-weight brains;
- environment;
- carcasses;
- species;
- render buffers;
- snapshots queued;
- chart/events.

Watch dead objects, unreturned transferable buffers, Pixi textures and unbounded stats.

## PART C — CALIBRATION

## 12. Failure modes to monitor

- all organisms become same generalist;
- population always extinct;
- population always cap;
- speed/vision/armor/attack always max;
- carnivory impossible;
- founder cannot find food;
- mutation destroys brain too fast;
- speciation fires on noise;
- speciation never fires.

## 13. Trait trade-off audit

Every non-neutral gene must have a credible lower-value advantage.

Examples:

- size: robustness vs energy/growth;
- speed: mobility vs maintenance/movement;
- vision: information vs maintenance;
- attack: access/defense vs maintenance/action energy;
- armor: protection vs speed/maintenance;
- metabolism: throughput vs basal cost;
- tolerance: habitat breadth vs maintenance;
- early maturity: earlier birth vs expensive development;
- longevity: opportunity vs repair maintenance;
- investment: child quality vs parent reproduction frequency.

Hue is intentionally neutral initially.

## 14. Parameter sweep harness

Create headless sweep command.

Example:

```bash
pnpm sweep --config experiments/mutation-rate.json
```

Run 10–30 seeds for important tuning conclusions.

Output JSON/CSV:

- survival;
- final population;
- species count;
- trait variance;
- biomass;
- runtime.

Do not tune from one lucky seed.

## 15. Founder tuning rule

Founder must be viable but mediocre.

It should leave evolutionary room for alternative speed, sensing, diet and life-history strategies.

Never add hidden founder survival bonus.

## 16. Speciation calibration

Synthetic negative: one noisy phenotype cloud -> no split.

Synthetic positive: two persistent clusters -> split after required stability.

Ecological manual scenario: geographic separation + distinct pressure should eventually be capable of split.

## PART D — ROADMAP

## Milestone 0 — Repository

Deliver:

- pnpm workspace;
- Vite React shell;
- engine/protocol/renderer/persistence/ui/shared packages;
- strict TS;
- lint/format;
- Vitest;
- `pnpm verify` running typecheck+lint+test+build.

Acceptance: all pass.

## Milestone 1 — Determinism skeleton

Deliver:

- versions;
- fixed-point helpers;
- trig LUT;
- PRNG/test vector;
- engine empty fixed step;
- state hash;
- default config shell;
- headless runner.

Acceptance: 10k empty ticks deterministic; serialize/resume core hash exact.

## Milestone 2 — Environment

Deliver:

- procedural deterministic map;
- moisture/temp/fertility/biomes;
- plants/growth;
- spawn validation.

Acceptance: approved seeds valid; 100k environment soak; golden environment hashes.

## Milestone 3 — Organism mechanics

Deliver:

- SoA;
- genome phenotype;
- spatial hash;
- sensors;
- quantized NN;
- founder brain;
- movement;
- plant feeding;
- metabolism/growth/aging/death.

Acceptance: founder forages/survives calibrated world; no heuristic after spawn; deterministic 10k.

## Milestone 4 — Evolution

Deliver:

- reproduction;
- gene mutation;
- brain mutation;
- generation/parent;
- cap diagnostics.

Acceptance: multiple generations; 100k soak; deterministic replay.

## Milestone 5 — Predation

Deliver:

- carcass;
- meat sensing/eating;
- diet trade-off;
- attack;
- simultaneous damage;
- armor;
- kill attribution.

Acceptance: predator/prey fixture; mutual combat test; food/energy invariants.

## Milestone 6 — Worker + renderer

Deliver:

- protocol;
- scheduler;
- MAX yielding;
- render snapshot;
- Pixi terrain/particles;
- camera;
- selection;
- time controls.

Acceptance: sim off main thread; 2k visual slice smooth on reference desktop; UI responsive in MAX.

## Milestone 7 — Observation UI

Deliver top bar, inspector, stats, charts, overlays, responsive panels.

Acceptance: user can understand organism state and global ecological trend.

## Milestone 8 — Species/history

Deliver registry, deterministic split, extinction, timeline, tree, species inspector.

Acceptance: synthetic tests + calibrated real split.

## Milestone 9 — Interventions

Deliver command log, stroke resampling, climate/moisture/fertility/terrain/biomass/meteor.

Acceptance: identical command list => identical hash; event logged.

## Milestone 10 — Persistence

Deliver IndexedDB manifests/snapshots/autosave/manual load/checksum/versioning.

Acceptance: save/reload hash test exact.

## Milestone 11 — Rewind/branch

Deliver nearest snapshot replay, progress, preview mode, return present, branch.

Acceptance: historical hashes match; no-command branch matches control; original unchanged.

## Milestone 12 — Performance/calibration

Deliver benchmark, phase profiler, memory metrics, LOD/culling/buffer pooling if justified, stats downsampling, 1M soak, 10+ seed suite.

## Milestone 13 — PWA/mobile

Deliver responsive mobile polish, installable web shell, lifecycle behavior, then Capacitor iOS/Android smoke tests.

Same engine hashes on platforms for same build/config/commands.

## Post-MVP gate

Only now consider:

- sexual reproduction;
- evolvable mutation rate;
- NEAT/topology;
- aquatic life;
- parasites;
- niche construction;
- guided experiments;
- cloud/server worlds.

## PART E — BROWSER E2E

Playwright scenarios:

1. create explicit-seed world;
2. pause/resume;
3. speed change;
4. organism selection/inspector;
5. intervention creates event;
6. save/reload;
7. species tree;
8. rewind;
9. branch;
10. mobile viewport basic pan/zoom/sheets.

Matrix: Chromium, Firefox, WebKit where practical. Real iOS/Android after Capacitor phase.
