# 01 — Product Requirements and Scope

## 1. Product thesis

EON is a **digital ecosystem observatory**, not a conventional survival game.

Primary emotional payoff:

> “I changed one environmental pressure, let thousands of simulated generations pass, and the population solved the problem in a way I did not explicitly program.”

Secondary payoff:

> “I can inspect the lineage tree, timeline and statistics and understand how the outcome emerged.”

## 2. Player role

The player acts as:

1. **Observer** — watches organisms/species/populations.
2. **Experimenter** — changes environmental variables and compares outcomes.
3. **World shaper** — changes terrain/resources/climate or triggers catastrophes.

The player never gives movement, combat or feeding orders to an organism.

## 3. MVP mode: Sandbox

Flow:

1. New World.
2. Enter/randomize seed.
3. Start calibrated default world.
4. Observe founder population.
5. Inspect organism/species.
6. Change simulation speed.
7. Apply environmental intervention.
8. Observe ecological/evolutionary response.
9. Inspect timeline and tree.
10. Save locally.
11. Rewind to an earlier point.
12. Create a branch for an alternative experiment.

Guided challenges and hypothesis missions are post-MVP.

## 4. Core user stories

### World creation

- create world from explicit seed;
- copy seed;
- same engine+seed+config+commands reproduce authoritative state;
- display engine version in world metadata.

### Observation

- pan/zoom smoothly;
- click/tap organism;
- follow organism;
- inspect energy, health, age, generation, diet, kills, genes, species, local biome/temp;
- inspect species population and mean phenotype;
- toggle ecological heatmaps.

### Time

- pause;
- 1×, 5×, 20×, 100×, MAX;
- UI displays requested speed and achieved ticks/s;
- MAX reduces render frequency rather than altering rules.

### Player agency

MVP tools:

- global temperature offset;
- local warm/cool brush;
- wet/dry brush;
- fertility brush;
- raise/lower terrain;
- add/remove plant biomass;
- meteor catastrophe;
- organism translocation as late-MVP if schedule permits.

Every accepted intervention is an immutable historical command/event.

### Evolution/history

- active + extinct species count;
- tree of life;
- species origin/end state;
- timeline of major events;
- historical rewind in read-only preview;
- create branch from history.

### Persistence

- autosave;
- manual save;
- restore after browser reload;
- versions/checksums;
- incompatible/corrupt saves fail safely and are not overwritten.

## 5. Explicit non-goals

Not required in MVP:

- scientifically complete biology/geology;
- mating/sexes;
- Mendelian genetics;
- individual plants;
- aquatic ecology;
- pathogens/parasites;
- nests/construction;
- social signaling;
- changing NN topology;
- auth/cloud;
- multiplayer;
- server simulation while app is closed;
- sound;
- narrative campaign.

## 6. Required signals of “life”

The system must visibly support autonomous:

- wandering/search;
- feeding;
- local resource depletion;
- crowding;
- reproduction;
- starvation;
- movement across habitat;
- combat/predation if evolved or present in a test genotype;
- expansion and local population cycles.

Do not script flocking/fleeing/predation roles. If they emerge from sensors + inherited controller, that is a success.

## 7. Required signals of evolution

A calibrated accelerated run must be capable of showing:

- gene distribution change;
- descendant phenotypes differing from founder;
- differential survival/reproduction;
- extinction;
- ecological specialization;
- stable lineage divergence;
- automatic species split.

Do not require a specific spontaneous predator at a specific tick in automated tests.

## 8. Causality/analytics

After an intervention, user should be able to inspect nearby changes in:

- population;
- species count;
- plant biomass;
- mean traits;
- deaths/births;
- diet composition.

UI should say “changes after intervention” unless an A/B branch comparison supports stronger causal interpretation.

## 9. Primary UI states

1. World list/start.
2. New world.
3. Running world.
4. Paused world.
5. Selected organism.
6. Selected species.
7. Tree.
8. Timeline/history.
9. Historical preview.
10. Save/load error.
11. Development diagnostics.

## 10. Responsive layout

Desktop:

```text
Top status/time bar
Left tools | world canvas | right inspector
Bottom timeline/charts
```

Phone:

```text
compact top bar
full canvas
bottom sheet: inspector/tools/timeline
```

Controls:

- desktop: wheel zoom, drag pan, click select;
- mobile: pinch zoom, one-finger pan, tap select.

## 11. UX guardrails

- show actual slowdown rather than faking requested speed;
- hard population cap must generate warning because it biases evolution;
- historical preview must be visually obvious;
- no interventions while viewing history without creating a branch;
- never silently regenerate a save with a new engine and claim it is the same history;
- color must not be the only status signal.

## 12. MVP release gate

Do not call MVP finished until:

- headless determinism passes;
- save/replay passes;
- at least 10 calibration seeds survive reasonable startup;
- population does not normally slam into engine cap;
- a controlled selection experiment demonstrably shifts lineage success;
- at least one calibrated fragmented/environmentally divergent run can create an automatic species split;
- web UI makes these outcomes inspectable.
