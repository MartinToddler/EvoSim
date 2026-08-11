# 05 — Evolution, Species, Statistics and History

## 1. Fitness rule

There is no explicit fitness score.

Selection happens through survival + realized reproduction.

Analytics may calculate offspring/descendant success after the fact but may never modify biology.

## 2. Species semantics

MVP is asexual, so reproductive-isolation species definitions do not apply.

Internally/UX may say “species”, but tooltip/docs should explain that these are automatically detected **evolutionary lineages / morphospecies** based on persistent phenotype divergence.

## 3. Ecological trait vector

Use normalized phenotype dimensions for clustering, excluding hue and individual NN weights.

Recommended dimensions:

1. adult size;
2. effective max speed;
3. acceleration;
4. turn;
5. vision range;
6. FOV;
7. diet;
8. attack;
9. armor;
10. metabolic pace;
11. thermal optimum;
12. thermal tolerance;
13. maturity;
14. max age;
15. offspring investment.

Version this vector definition.

## 4. Distance

Weighted Euclidean squared distance:

```text
D²(a,b) = Σ w[i]*(a[i]-b[i])² / Σ w[i]
```

Start equal weights. Tune only with evidence.

Use fixed-point/integer calculations.

## 5. Species record

Persist:

```ts
id
parentSpeciesId
originTick
endTick // 0 active
endReason // active | split | extinct
population
centroidTraits
originCentroid
founderEntityId
generationAtOrigin
totalBirths
totalDeaths
totalKills
plantEnergyConsumed
meatEnergyConsumed
splitCandidateState
```

All founders begin Species 1.

## 6. Analysis interval

Default every 400 ticks.

Only analyze species with at least `2 * MIN_DAUGHTER_POP`.

Suggested:

```text
MIN_DAUGHTER_POP = 20
```

## 7. Deterministic bifurcation detector

Goal: stable bimodality, not an outlier.

For each eligible species:

### Gather

Collect living members in deterministic order.

### Seed two centroids

1. A = lowest entity ID member.
2. B = farthest from A; tie lowest ID.
3. A2 = farthest from B; tie lowest ID.
4. initialize centroids A2 and B.

### 2-means

Run exactly 6 iterations:

1. assign to nearer centroid;
2. tie -> cluster A;
3. recompute integer centroid;
4. empty cluster => fail.

### Candidate conditions

- both populations >= minimum;
- centroid distance >= threshold;
- optionally within-cluster spread acceptable.

Initial normalized RMS threshold hypothesis ≈0.22.

### Stability

Must pass for e.g. 5 consecutive species-analysis intervals.

Compare new candidate centroids with previous, allowing A/B swap.

Failure resets or decays candidate counter; choose one deterministic policy and test it. Recommended reset for v0.1 simplicity.

### Split

When stable:

- parent ends with reason `split`;
- create child A and child B;
- both child `parentSpeciesId = old parent`;
- reassign all living members;
- emit `SpeciesSplit` event.

This creates a clean bifurcating tree.

## 8. Extinction

When species population reaches zero:

- endTick = current tick;
- endReason = extinct;
- emit event;
- retain record permanently.

A parent ended by split is not “extinct”.

## 9. Species naming

MVP fallback:

```text
Species 0001
Species 0002
```

Deterministic generated names are cosmetic and post-core.

User renames are metadata and should not affect authoritative state hash.

## 10. Statistics cadence

Every 100 ticks.

World sample:

- tick/year;
- population;
- active species;
- cumulative extinct;
- total plant biomass;
- total meat/carcass biomass;
- births by interval;
- deaths by cause;
- kills;
- average energy ratio;
- selected mean traits;
- plant/meat energy consumption.

Species sample:

- population;
- mean traits;
- plant/meat fractions;
- births/deaths/kills;
- mean age;
- mean energy.

## 11. Time-series retention

Do not store infinite raw samples.

Use multiresolution aggregation:

- Tier 0: raw 100-tick samples for recent window;
- Tier 1: each 10 Tier-0 points aggregated;
- Tier 2: each 10 Tier-1;
- continue as needed.

Store count/min/max/mean/last for chart-relevant metrics.

## 12. World event schema

```ts
interface WorldEvent {
  id: number;
  tick: number;
  type: WorldEventType;
  severity: "info" | "notable" | "major";
  speciesIds?: number[];
  entityIds?: number[];
  region?: { x: number; y: number; radius: number };
  payload: VersionedPayload;
}
```

## 13. MVP event types

- `WorldCreated`
- `PlayerIntervention`
- `SpeciesSplit`
- `SpeciesExtinct`
- `PopulationBoom`
- `PopulationCrash`
- `FirstPredation`
- `CarnivoreLineageDetected`
- `MassExtinction`
- `PopulationCapReached`
- optional `RegionColonized`.

Do not timeline every birth/death.

## 14. First predation

Emit first time a combat-attributed death occurs.

Include attacker/victim entity + species + position.

## 15. Carnivore lineage

Use observed intake rather than diet gene alone.

Example requirement over rolling window:

- species population >=10;
- adequate food observations;
- meat energy fraction >=60%;
- persists several statistics intervals.

This can create world-first event and species badge.

## 16. Boom/crash

Compare to rolling baseline and require absolute + relative change.

Example starting thresholds:

- boom: +75%;
- crash: -50%;
- minimum absolute population delta;
- event cooldown/debounce.

Tune; avoid timeline spam.

## 17. Mass extinction

Example:

- world has at least 8 active species at window start;
- >=40% become extinct inside configured interval.

Emit major event with affected species IDs.

## 18. Colonization optional

Later MVP can detect stable expansion into connected geographic regions.

Must use sustained population, not one wandering individual.

## 19. Tree of life

Node = species record.

Edge = parent -> child.

Split => two child nodes.

Tree UI should show:

- time span;
- active/extinct/split status;
- population;
- dominant observed diet;
- selected species focus.

Tree visualization is derived, not authoritative.

## 20. Individual genealogy retention

Every live organism stores parent ID.

Do not retain every dead organism forever.

Keep:

- recent-dead ring buffer;
- event-notable organisms;
- species founders;
- user-pinned lineages later.

Primary permanent history is species-level.

## 21. Analytics

Non-authoritative metrics can include:

- trait variance;
- diversity indices;
- species turnover;
- generation time;
- realized offspring count;
- extinction rate;
- phenotype distance.

Never feed analytics back into selection.

## 22. Historical view

Clicking timeline intervention should show nearby trends.

Historical preview reconstructs actual state at target tick and allows inspection.

No intervention in preview unless user creates a new branch.

## 23. Branch experiment architecture

Determinism enables:

```text
snapshot at T
├─ control branch
└─ intervention branch
```

A/B comparison UI is post-MVP, but persistence must support branch metadata from the beginning.
