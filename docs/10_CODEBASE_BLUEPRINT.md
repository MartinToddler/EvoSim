# 10 — Codebase Blueprint: Files, Interfaces and Module Contracts

This is a recommended implementation map. File names may be adjusted only if responsibilities remain equally explicit.

## 1. Target repository tree

```text
/
├─ apps/
│  └─ web/
│     ├─ src/
│     │  ├─ main.tsx
│     │  ├─ App.tsx
│     │  ├─ app/
│     │  │  ├─ createRuntime.ts
│     │  │  ├─ WorldSession.ts
│     │  │  └─ appStore.ts
│     │  ├─ worker/
│     │  │  ├─ simulation.worker.ts
│     │  │  └─ WorkerClient.ts
│     │  ├─ screens/
│     │  │  ├─ WorldListScreen.tsx
│     │  │  └─ SimulationScreen.tsx
│     │  └─ styles/
│     └─ vite.config.ts
│
├─ packages/
│  ├─ engine/
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ version.ts
│  │     ├─ config/
│  │     │  ├─ SimulationConfig.ts
│  │     │  ├─ defaultConfig.ts
│  │     │  └─ validateConfig.ts
│  │     ├─ math/
│  │     │  ├─ fixed.ts
│  │     │  ├─ angle.ts
│  │     │  ├─ trigLut.ts
│  │     │  ├─ hash.ts
│  │     │  └─ noise.ts
│  │     ├─ random/
│  │     │  ├─ Xoshiro128.ts
│  │     │  └─ statelessNoise.ts
│  │     ├─ world/
│  │     │  ├─ WorldState.ts
│  │     │  ├─ EnvironmentStore.ts
│  │     │  ├─ generateWorld.ts
│  │     │  ├─ validateWorld.ts
│  │     │  ├─ biomes.ts
│  │     │  ├─ plants.ts
│  │     │  └─ environmentUpdate.ts
│  │     ├─ organisms/
│  │     │  ├─ OrganismStore.ts
│  │     │  ├─ GenomeStore.ts
│  │     │  ├─ phenotype.ts
│  │     │  ├─ growth.ts
│  │     │  ├─ metabolism.ts
│  │     │  └─ death.ts
│  │     ├─ brain/
│  │     │  ├─ BrainLayout.ts
│  │     │  ├─ inferBrain.ts
│  │     │  ├─ sensors.ts
│  │     │  ├─ intents.ts
│  │     │  └─ founderBrain.ts
│  │     ├─ spatial/
│  │     │  ├─ SpatialGrid.ts
│  │     │  └─ queries.ts
│  │     ├─ ecology/
│  │     │  ├─ feedingClaims.ts
│  │     │  ├─ CarcassStore.ts
│  │     │  ├─ combatClaims.ts
│  │     │  └─ reproduction.ts
│  │     ├─ genetics/
│  │     │  ├─ genes.ts
│  │     │  ├─ mutation.ts
│  │     │  └─ founderGenome.ts
│  │     ├─ evolution/
│  │     │  ├─ SpeciesStore.ts
│  │     │  ├─ traitVector.ts
│  │     │  ├─ speciation.ts
│  │     │  └─ extinction.ts
│  │     ├─ history/
│  │     │  ├─ EventStore.ts
│  │     │  ├─ eventDetection.ts
│  │     │  └─ StatisticsStore.ts
│  │     ├─ commands/
│  │     │  ├─ commandQueue.ts
│  │     │  └─ applyCommand.ts
│  │     ├─ snapshot/
│  │     │  ├─ EngineSnapshot.ts
│  │     │  ├─ serialize.ts
│  │     │  └─ deserialize.ts
│  │     └─ SimulationEngine.ts
│  │
│  ├─ protocol/
│  │  └─ src/
│  │     ├─ version.ts
│  │     ├─ commands.ts
│  │     ├─ messages.ts
│  │     ├─ dto.ts
│  │     └─ renderSnapshot.ts
│  │
│  ├─ renderer/
│  │  └─ src/
│  │     ├─ EonRenderer.ts
│  │     ├─ Camera.ts
│  │     ├─ layers/
│  │     ├─ terrain/
│  │     ├─ organisms/
│  │     ├─ selection/
│  │     └─ overlays/
│  │
│  ├─ persistence/
│  │  └─ src/
│  │     ├─ db.ts
│  │     ├─ manifests.ts
│  │     ├─ snapshots.ts
│  │     ├─ commands.ts
│  │     ├─ history.ts
│  │     └─ migrations.ts
│  │
│  ├─ ui/
│  │  └─ src/
│  │     ├─ components/
│  │     ├─ inspector/
│  │     ├─ timeline/
│  │     ├─ tree/
│  │     ├─ tools/
│  │     └─ charts/
│  │
│  └─ shared/
│     └─ src/
│        ├─ assert.ts
│        ├─ ids.ts
│        └─ result.ts
│
├─ scripts/
│  ├─ headless.ts
│  ├─ benchmark-engine.ts
│  └─ sweep.ts
└─ tests/ or co-located *.test.ts
```

## 2. SimulationEngine composition

Recommended class/object owns stores but delegates phases.

```ts
class SimulationEngine {
  readonly config: SimulationConfig;
  readonly seed: number;
  tick = 0;

  readonly rng: Xoshiro128;
  readonly environment: EnvironmentStore;
  readonly organisms: OrganismStore;
  readonly genomes: GenomeStore;
  readonly carcasses: CarcassStore;
  readonly species: SpeciesStore;
  readonly stats: StatisticsStore;
  readonly events: EventStore;
  readonly commands: CommandQueue;
  readonly spatialPre: SpatialGrid;
  readonly spatialPost: SpatialGrid;
  readonly scratch: EngineScratch;

  step(): void;
}
```

Do not expose stores directly to React.

## 3. `step()` pseudocode

```ts
step(): void {
  applyCommandsForTick(this);

  if (tick % envInterval === 0) {
    updateEnvironment(this);
  }

  spatialPre.rebuild(organisms);
  senseAll(this);
  inferAllBrains(this);

  integrateMovement(this);
  resolveTerrain(this);
  resolveSoftCollisions(this);

  spatialPost.rebuild(organisms);

  buildFeedingClaims(this);
  resolveFeedingClaims(this);

  buildCombatClaims(this);
  resolveCombatClaims(this);

  applyPhysiology(this);
  finalizeDeaths(this);
  resolveReproduction(this);

  if (tick % carcassInterval === 0) updateCarcasses(this);
  if (tick % speciesInterval === 0) analyzeSpecies(this);
  if (tick % statsInterval === 0) collectStatsAndDetectEvents(this);

  tick++;
}
```

The exact increment-at-start/end convention must be selected once, documented and covered by hash tests. Recommended: apply commands scheduled for current `tick`, execute phases, then increment.

## 4. Scratch memory

Create one reusable `EngineScratch` allocated for max population.

Suggested arrays:

```ts
sensorValues: Int16Array // maxOrg * 20
hiddenValues: Int16Array // maxOrg * 12
throttleQ: Uint16Array
turnQ: Int16Array
eatQ: Uint16Array
attackQ: Uint16Array
reproduceQ: Uint16Array

feedingRequest: Uint16Array
feedingTargetType: Uint8Array
feedingTargetIndex: Int32Array

damageAccumQ: Int32Array
bestDamageQ: Int32Array
bestAttackerId: Uint32Array

moveCorrectionX: Int32Array
moveCorrectionY: Int32Array

deathCause: Uint8Array
pendingDeath: Uint8Array
```

Do not allocate sensor arrays per organism/tick.

## 5. EnvironmentStore

Constructor preallocates 65,536-cell arrays.

Methods should be low-level:

```ts
cellIndexFromPosition(x, y): number
isWaterCell(index): boolean
getTemperatureCentiC(index): number
getPlantBiomass(index): number
recomputeDerivedCell(index): void
recomputeRegion(minX, minY, maxX, maxY): void
```

World generation fills authoritative arrays directly, then computes derived caches.

## 6. OrganismStore slot lifecycle

Recommended API:

```ts
allocateSlot(): number
releaseSlot(slot: number): void
spawnFromGenome(...): EntityId
isAliveSlot(slot): boolean
findSlotByEntityId(id): number
```

Do not compact arrays every death. Stable slots + free list avoid O(N) moves and preserve deterministic slot iteration semantics.

## 7. GenomeStore layout

Ecological genes can be individual Uint16 arrays for hot access or a packed `Uint16Array(maxOrg * GENE_COUNT)`.

Brain weights should be packed:

```ts
brainWeights = new Int16Array(maxOrganisms * 400)
weightOffset(slot) = slot * 400
```

Copy child with TypedArray `set` over subarray or optimized loop, then mutate selected weights.

Benchmark both if this becomes hot.

## 8. Derived phenotype caching

Do not recompute expensive gene mapping every tick if genome never changes during an organism’s life.

Cache per organism:

- adult radius;
- gene max speed;
- acceleration;
- max turn;
- vision range/FOV thresholds;
- plant/meat efficiency;
- attack/armor;
- metabolic pace;
- thermal opt/tolerance;
- maturity/max age;
- offspring investment;
- maintenance capability coefficients.

Current radius/mass still changes with development.

Cache is authoritative-derived: either save it or deterministically recompute on load. Prefer recompute from genome on load to reduce snapshot duplication.

## 9. Spatial query API

Avoid returning JS arrays.

Use callback/scratch visitor or scan inline:

```ts
findNearestVisibleCreature(engine, observerSlot): number // target slot or -1
computeCrowdingQ(engine, observerSlot): number
findNearestCarcass(...): number
```

Target selection must encode all ties.

## 10. Sensor pipeline

`senseAll` loops live slots and writes contiguous sensor block.

Sensor order fixed by `BrainLayout` enum/constants.

Example:

```ts
enum BrainInput {
  Bias = 0,
  Energy = 1,
  ...
  Internal = 19
}
```

Never use anonymous numeric indices in unrelated modules.

## 11. Brain inference API

```ts
function inferBrain(
  sensorBaseOffset: number,
  weightBaseOffset: number,
  sensors: Int16Array,
  weights: Int16Array,
  hiddenScratch: Int16Array,
  hiddenBaseOffset: number,
  out: BrainOutputWriter
): void
```

Alternatively infer inline per slot for cache locality. Maintain clear weight section offsets:

```ts
IH_OFFSET = 0
HO_OFFSET = 240
IO_OFFSET = 300
TOTAL = 400
```

Golden vector test required.

## 12. Feeding claim structures

For plants, aggregate by environment cell.

Efficient design:

```ts
plantDemandPerCell: Uint32Array(65536)
plantAllocatedPerSlot: Uint16Array(maxOrg)
```

Pass 1: each eater sets desired amount and increments cell demand.

Pass 2: determine base proportional allocation.

Pass 3: distribute integer remainder deterministically among claimants. Avoid O(cell*all organisms); use linked claimant list or second organism pass checking its claimed cell.

For carcasses, use analogous per-carcass demand.

## 13. Combat claim structures

Each organism attacks at most one target/tick.

Arrays per target slot:

```ts
damageAccumQ
bestSingleDamageQ
bestAttackerId
```

Pass:

1. validate attacker/target/contact/energy;
2. deduct attack energy;
3. accumulate damage;
4. remember best contributor;
5. after all attackers, apply damage to each target;
6. mark combat death with attributed killer if health <=0.

Do not finalize death during attacker loop.

## 14. Death finalization order

Collect pending deaths during physiology/combat.

Finalize slots ascending:

1. capture required state;
2. species counters;
3. event counters;
4. create carcass (if capacity; if carcass cap reached, deterministically skip + diagnostics metric, not random replacement);
5. mark organism dead;
6. release slot after reproduction phase ordering rules are satisfied.

Because reproduction happens after death finalization in spec, dead slots may be added to free list before reproduction. LIFO reuse then becomes part of deterministic semantics. Test it.

## 15. Reproduction allocation order

Process living parent slots ascending.

This can bias access to the hard population cap only when cap is reached. Since cap is safety-only, accept and diagnose. Do not randomize order to hide the issue.

For normal ecology below cap there is no cap-order competition.

## 16. World command application

`CommandQueue` stores accepted commands sorted by `(tick, sequence)`.

At tick:

```ts
while cursor.command.tick === tick:
  applyCommand(command)
  emit intervention event metadata if applicable
  cursor++
```

Reject command scheduled in the past in live mode.

During deterministic replay, command log is authoritative and accepted without UI revalidation after schema validation.

## 17. State hashing module

Hash arrays without converting to JSON.

Canonical sequence explicitly listed in source and tests.

Include array lengths before bytes to avoid ambiguity.

Exclude derived cache only if guaranteed deterministic recompute; if a cache can influence future state, either hash it or prove/recompute it.

## 18. Snapshot serializer

Serializer must save fields needed to continue exactly.

At minimum:

- header;
- tick;
- seed/config;
- PRNG state;
- environment authoritative arrays;
- organism live-state arrays + slot/free-list state;
- genomes/weights for live slots or full capacity arrays if simpler;
- carcass store/free list;
- species registry/candidate state;
- command cursor/queued commands as needed;
- event/stat state used to detect future events;
- next IDs.

If saving only used slots, deserializer must reconstruct identical slot/free-list state or future hash can diverge.

Simplest v0.1: serialize capacity arrays + explicit free-list state. Optimize size later.

## 19. Headless scripts

### `scripts/headless.ts`

Arguments:

```text
--seed
--ticks
--config preset/path
--snapshot-out optional
--stats-out optional
```

Print final hash + basic world stats.

### `scripts/benchmark-engine.ts`

Same engine; wall-clock instrumentation outside engine.

### `scripts/sweep.ts`

Loads experiment definition and runs seeds/config variants, producing CSV/JSON.

## 20. Worker host class

`simulation.worker.ts` should be thin.

Responsibilities:

- parse protocol;
- own engine/session;
- schedule ticks;
- call persistence adapter;
- emit render/telemetry;
- report errors.

Do not put biological equations in Worker file.

## 21. `WorkerClient`

Main-thread typed facade:

```ts
createWorld(...): Promise<WorldReady>
setRunState(...): void
queueCommand(...): Promise<CommandAccepted>
queryEntity(...): Promise<EntityDetails>
querySpecies(...): Promise<SpeciesDetails>
save(): Promise<SaveResult>
rewind(...): Promise<void>
branch(...): Promise<WorldManifest>
dispose(): void
```

Correlate requests by `requestId`.

Render snapshots/events use subscriptions rather than request promises.

## 22. WorldSession composition root

One `WorldSession` may own:

- WorkerClient;
- EonRenderer;
- currently loaded manifest;
- subscriptions;
- selection state bridge.

Destroy cleanly when returning to world list:

- unsubscribe;
- stop renderer;
- terminate worker;
- release textures/buffers.

## 23. UI state policy

Safe for React store:

- world metadata;
- low-rate telemetry;
- run state;
- selected ID/details;
- selected species/details;
- active tool;
- timeline filters;
- save status;
- modal/sheet state.

Not React state:

- every x/y;
- every brain value every tick;
- raw environment arrays each tick.

## 24. Renderer object lifetime

Create particle capacity once and reuse.

Avoid destroy/create thousands of sprites each snapshot.

Update position/rotation/scale/tint in place.

Detailed close-up objects use a pool.

Terrain texture updated in place when possible.

## 25. Implementation warning list

Claude Code should explicitly avoid these common mistakes:

- using `setInterval` delta as simulation time;
- calling `Math.random` for mutations;
- making each organism a React component;
- making each plant a JS object;
- iterating all organism pairs;
- applying food consumption immediately in organism loop;
- applying combat damage immediately in attacker loop;
- storing only seed without PRNG state in snapshot;
- replaying old save with changed engine silently;
- allowing pointer event frequency to define brush commands;
- adding “if predator/herbivore” rules outside generic genes/actions;
- optimizing into WASM before profiling;
- adding backend before local deterministic MVP is stable.

## 26. First vertical headless demo

Before Pixi exists, a command should be able to print every N stats intervals:

```text
Tick 10000 | pop 301 | biomass 1.21e9 | births 88 | deaths 43 | gen max 5
Tick 20000 | pop 417 | biomass 1.17e9 | births 132 | deaths 16 | gen max 9
...
Final hash: ...
```

Exact numbers are not prescribed; this proves simulation is real without rendering.

## 27. First visual vertical slice

Only after headless reproduction works:

- static terrain;
- organism particles;
- pan/zoom;
- play/pause/speed;
- click one organism;
- display ID/energy/generation.

No tree, god tools or fancy visual phenotype needed for first slice.
