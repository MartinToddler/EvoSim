# 03 — Simulation Core, World and Ecology

## 1. World model

Bounded top-down 2D plane.

- Environment: fixed grid.
- Organisms: continuous fixed-point positions.
- Carcasses: continuous fixed-point positions.
- Spatial lookup: coarser uniform grid.
- Plants: biomass field, not individual entities.

## 2. Default dimensions

```ts
WORLD_SIZE_LU = 4096
ENV_GRID_SIZE = 256
ENV_CELL_SIZE_LU = 16
SPATIAL_CELL_SIZE_LU = 32

TARGET_TICKS_PER_SECOND_1X = 20
TICKS_PER_SIM_YEAR = 2000

INITIAL_ORGANISMS = 256
HARD_MAX_ORGANISMS = 8192
HARD_MAX_CARCASSES = 4096
```

Hard cap is a safety limit only. If reached, deterministic reproduction rejection + diagnostics event; never silently cull.

## 3. Fixed-point conventions

Authoritative hot state uses integer fixed point.

```ts
POS_SCALE = 256
Q = 4096
ANGLE_STEPS = 4096
TRIG_SCALE = 32767
```

Examples:

- 12.5 LU => position integer 3200;
- normalized 0.5 => 2048;
- heading 0..4095.

Precompute sin/cos LUTs. Avoid `Math.atan2`; sensors use local forward/lateral vector components.

## 4. PRNG

Implement project-owned deterministic xoshiro128** (or equivalent 32-bit algorithm with documented test vectors).

Methods:

```ts
nextU32()
nextInt(maxExclusive)
nextQ()
nextSignedQ()
approxNormalQ()
serializeState()
restoreState()
```

Approx-normal should use summed uniforms/Irwin-Hall, not Box-Muller transcendental math.

Use stateless hash noise `(seed, entityId, tick)` for per-entity sensory noise if possible to avoid global PRNG coupling.

## 5. IDs and slots

- Entity ID 0 invalid.
- Monotonic uint32 IDs; never reuse.
- Slots may be reused.
- Slot != entity ID.
- deterministic free-slot policy, e.g. LIFO stack.
- authoritative iteration ascending slot index.

Direct entity lookup Map is acceptable for queries, but iteration order of Map must never affect state.

## 6. Organism SoA skeleton

```ts
alive: Uint8Array
entityId: Uint32Array
x: Int32Array
y: Int32Array
vx: Int32Array
vy: Int32Array
angle: Uint16Array
energy: Int32Array
healthQ: Uint16Array
ageTicks: Uint32Array
generation: Uint32Array
parentEntityId: Uint32Array
speciesId: Uint32Array
lastDamageQ: Uint16Array
attackCooldown: Uint16Array
plantEnergyEaten: Uint32Array
meatEnergyEaten: Uint32Array
kills: Uint16Array
```

Genome/brain fields use parallel typed arrays.

## 7. Authoritative tick order

Versioned order:

```text
0  applyCommands
1  scheduledEnvironmentUpdate
2  buildPreMovementSpatialIndex
3  sense
4  runBrainsAndBuildIntents
5  integrateMovement
6  resolveTerrainAndSoftCollisions
7  buildPostMovementSpatialIndex
8  buildFeedingClaims
9  resolveFeedingClaims
10 buildCombatClaims
11 resolveCombatSimultaneously
12 applyMetabolismGrowthThermalAging
13 finalizeDeathsAndCreateCarcasses
14 resolveReproduction
15 scheduledCarcassDecay
16 scheduledSpeciesAnalysis
17 scheduledStatisticsAndEventDetection
18 optionalRenderSnapshot
```

Reordering requires engine version bump.

## 8. Scheduling intervals

> **Amended by ADR 0002 §4 (engine 0.1.1).** The first four intervals are authoritative and live in
> `SimulationConfig.time`; `AUTOSAVE_CHECK_INTERVAL` moved to `HostRuntimeConfig`. The test applied:
> a cadence is authoritative when it schedules one of the versioned tick phases in §7 above.
> Autosave is not among those nineteen phases — it copies state out and changes nothing.

Initial config:

```ts
ENVIRONMENT_UPDATE_INTERVAL = 20
CARCASS_DECAY_INTERVAL = 20
STATISTICS_INTERVAL = 100
SPECIES_ANALYSIS_INTERVAL = 400
AUTOSAVE_CHECK_INTERVAL = 2000
```

## 9. Coherent decision phase

Sensing reads coherent pre-decision state.

Brain writes intent arrays:

```ts
throttleQ
turnQ
eatQ
attackQ
reproduceQ
```

Interactions are resolved later.

Damage is accumulated then applied simultaneously.

Food claims are aggregated before allocation to reduce entity-order bias.

## 10. Spatial hash

`WORLD_SIZE / SPATIAL_CELL = 128`, so grid 128×128.

```ts
head: Int32Array(128 * 128) // -1 empty
next: Int32Array(HARD_MAX_ORGANISMS)
```

Rebuild deterministically.

Nearest target tie:

1. lower squared distance;
2. lower entity ID.

Queries inspect grid cells row-major.

## 11. Movement

Brain outputs:

- throttle `[0,Q]`;
- turn `[-Q,Q]`.

Process:

1. angle += turn-scaled maxTurn;
2. target velocity from LUT heading * max speed * throttle;
3. current velocity approaches target by max acceleration;
4. environment movement multiplier;
5. integrate position;
6. terrain constraint;
7. soft overlap separation.

No render-frame delta.

## 12. Water and world boundary

Terrestrial organism may accidentally enter water.

Defaults:

- water speed multiplier 0.25;
- movement energy multiplier 4.0;
- 20 tick grace;
- then health damage;
- water-danger-ahead sensor supports avoidance evolution.

Boundary clamps position and acts as impassable danger.

No toroidal wrap in MVP.

## 13. Soft collisions

Allow overlap but apply small deterministic separation when center distance < sum radii.

If exactly same position, derive separation direction from entity-ID hash.

No rigid-body engine.

## 14. Environment arrays

Per 256² cell:

```ts
elevationQ: Uint16Array
baseMoistureQ: Uint16Array
moistureOffsetQ: Int16Array
fertilityQ: Uint16Array
baseTemperatureCentiC: Int16Array
temperatureOffsetCentiC: Int16Array
biome: Uint8Array
plantBiomass: Uint16Array
plantCapacity: Uint16Array
```

Derived/cached:

- passability;
- plant gradient;
- visualization pixels.

## 15. Procedural world generation

Goal:

- ocean borders;
- major connected land;
- islands/peninsulas;
- several ecological zones;
- viable founder region;
- geographic barriers.

Use deterministic project-owned integer lattice/value noise.

Suggested octave structure:

```text
elevationRaw =
  0.55 * noise(1/64)
+ 0.30 * noise(1/32)
+ 0.15 * noise(1/16)
```

Apply edge falloff.

Initial sea level about 0.46 normalized; mountain threshold about 0.78.

World generation validation:

- land 35–70%;
- connected founder habitat above minimum;
- total plant capacity above minimum;
- ideally >= 3 biome classes.

If invalid, deterministically retry with sub-seed derived from original seed + attempt number.

## 16. Moisture

Concept:

```text
moisture =
  0.65 * independent noise
+ 0.20 * inverse elevation
+ 0.15 * water influence
+ player offset
```

Water influence can be a deterministic grid distance/dilation approximation.

Final clamp `[0,Q]`.

## 17. Temperature

Simplified ecological field:

```text
temperature =
  equator base
- latitude cooling
- elevation cooling
+ low-frequency noise
+ global offset
+ local player offset
```

Typical default range roughly -15°C to +35°C.

Not intended as Earth climate simulation.

## 18. Fertility

Persistent `[0,Q]` field derived from moderate temp, moisture, elevation and noise.

Player fertility brush can change it.

## 19. Biomes

```ts
enum Biome {
  Water = 0,
  Grassland = 1,
  Forest = 2,
  Desert = 3,
  Tundra = 4,
  Mountain = 5
}
```

Suggested rule order:

1. below sea => water;
2. above mountain => mountain;
3. temp < -3°C => tundra;
4. moisture < 0.25 and temp > 18°C => desert;
5. moisture > 0.62 and fertility > 0.55 => forest;
6. else grassland.

Recompute affected cells after persistent edits.

## 20. Plants

Plants are biomass field.

Suggested biome base capacities:

```text
Water       0
Grassland 36000
Forest    52000
Desert     7000
Tundra    10000
Mountain   4000
```

Actual capacity = base × fertility × broad moisture/temp suitability.

### Growth

Logistic:

```text
delta = rate * biomass * (capacity - biomass) / capacity
```

Include tiny seed-bank regeneration below threshold so a cell can recover from exactly zero.

Initial per-environment-step rates:

```text
Grassland .012
Forest    .009
Desert    .003
Tundra    .003
Mountain  .0015
```

All are tuning constants.

## 21. Plant feeding allocation

Organisms submit claims.

If sum claims <= biomass => satisfy all.

Else allocate proportional shares, then deterministic integer remainder by ascending entity ID.

Energy gain:

```text
allocated biomass
× PLANT_ENERGY_PER_BIOMASS
× plant digestion efficiency
```

Never let loop order drain a cell first.

## 22. Plant sensing

No nearest grass objects.

Cache local gradient from neighboring environment cells.

Inputs:

- local plant density;
- gradient forward component;
- gradient lateral component.

## 23. Carcasses

Death creates carcass:

```ts
entityId
x
y
remainingMeat
sourceSpeciesId
ageTicks
```

Initial meat derives from current body mass + bounded remaining-energy contribution.

Carcass food claims are aggregated/proportional exactly like plant claims.

Decay every environment/decay interval, affected at least by temperature.

## 24. Diet trade-off

Do NOT use two independently maximizable digestion genes.

Use one signed `diet` gene:

- -1 herbivore specialist;
- 0 generalist;
- +1 carnivore specialist.

Affinity:

```text
herb = (Q - diet) / 2
carn = (Q + diet) / 2
```

Efficiency can use squared affinity:

```text
efficiency = 0.20 + 0.80 * affinity²
```

This produces specialist advantage with generalist floor.

## 25. Player environmental commands

### Global temperature

Persistent global centi-C offset.

### Temperature brush

Persistent radial local temperature offset.

### Moisture brush

Persistent local moisture offset.

### Fertility brush

Persistent soil change.

### Terrain raise/lower

Changes elevation, recomputes water/biome/capacity. Organisms on newly flooded cells use water penalty; they are not instantly deleted.

### Biomass add/remove

Changes current food, not long-term capacity.

### Meteor

Deterministic radial effects:

- organism damage;
- biomass loss;
- terrain depression;
- optional fertility change;
- timeline event.

## 26. Founder spawn

Spawn 256 organisms in deterministic viable fertile land region.

Default:

- same founder genome;
- calibrated viable neural weights;
- randomized positions from world PRNG;
- initial energy 65–80% max;
- no special heuristic AI after spawn.

## 27. World tests

Assert:

- identical seed hash;
- valid land/spawn;
- no array overflow;
- biomass <= capacity except explicitly allowed transient brush overfill;
- world generation deterministic;
- environment update remains valid after 100k headless ticks.
