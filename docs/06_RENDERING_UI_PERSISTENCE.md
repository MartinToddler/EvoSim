# 06 — Rendering, UI, Persistence, Replay and Branching

## PART A — RENDERING

## 1. Scene layers

Recommended Pixi hierarchy:

```text
Root
├─ TerrainLayer
├─ EnvironmentOverlayLayer
├─ CarcassLayer
├─ OrganismParticleLayer
├─ OrganismDetailLayer
├─ SelectionLayer
├─ WorldAnnotationsLayer
└─ DebugLayer
```

React DOM UI sits outside canvas.

## 2. Terrain texture

Environment is 256², ideal for low-resolution data texture/image.

Visual channels:

- biome base;
- elevation shade;
- vegetation intensity;
- water.

Persistent terrain/biome edit => regenerate affected texture.

Vegetation display updates only ~2–5 Hz.

## 3. Organism LOD

### LOD 0: world scale

If body screen radius <~1.5px:

- point/light particle;
- tint only;
- no phenotype detail.

### LOD 1: ecosystem

~1.5–8px:

- Pixi `ParticleContainer`;
- base body texture;
- rotation;
- tint;
- x/y scale encodes size/aspect.

### LOD 2: close

>~8px:

Promote visible limited subset, max ~250:

- eye;
- armor rim;
- jaw/attack marker;
- contour.

Selected organism promoted regardless where practical.

## 4. Visual phenotype mapping

```text
size -> scale
speed -> elongation
armor -> width/rim
vision -> eye size
attack -> front jaw/spike
hue -> tint
development -> juvenile scale
```

Far LOD need not reproduce every feature.

## 5. Camera

State:

```ts
x
y
zoom
mode: free | follow
followEntityId?
```

Desktop:

- wheel zoom around pointer;
- drag pan;
- click select;
- optional double-click follow.

Mobile:

- pinch;
- one finger pan;
- tap;
- long-press contextual action.

Camera interpolation is non-authoritative.

## 6. Selection

Avoid thousands of Pixi event handlers.

Process:

1. screen->world transform;
2. nearest render-snapshot organism within pixel tolerance;
3. nearest then entity ID tie;
4. show immediate ring;
5. `QUERY_ENTITY` to Worker;
6. populate inspector.

## 7. Heatmaps

MVP:

- population density;
- species/diversity;
- plant biomass;
- temperature;
- moisture.

Use coarse grid -> texture. One heavy overlay at a time. Opacity control.

## PART B — UI

## 8. Desktop layout

```text
┌─────────────────────────────────────────────────────────┐
│ world | year | pop | species | time | save              │
├──────┬──────────────────────────────────────┬───────────┤
│tools │                canvas                │ inspector │
├──────┴──────────────────────────────────────┴───────────┤
│ timeline / charts                                       │
└─────────────────────────────────────────────────────────┘
```

Canvas remains dominant.

## 9. Top bar

Show:

- world name;
- seed/copy;
- simulated year;
- population;
- species;
- pause/play;
- speed buttons;
- actual TPS when behind target;
- save state.

## 10. Tool palette

### Climate

- global temperature;
- heat/cool;
- wet/dry.

### Ecology

- fertility;
- biomass.

### Terrain

- raise/lower.

### Catastrophe

- meteor.

### Lab

- translocate late MVP.

Each shows radius/strength and whether effect is persistent.

Do not promise a biological outcome (“creates predators”); describe pressure (“reduces plant resources”).

## 11. Organism inspector

### Overview

- ID;
- species;
- generation;
- age;
- energy;
- health;
- observed diet;
- kills.

### Phenotype

16 genes as bars + human units.

### Costs

Current/recent:

- basal;
- movement;
- sensory maintenance;
- armor/attack maintenance;
- thermal stress.

### Brain

MVP collapsible debug-style current inputs/outputs. Full network diagram optional/post-MVP.

### History

- parent ID;
- birth tick;
- follow action.

## 12. Species inspector

- ID/name;
- active/extinct/split;
- origin/end;
- parent;
- population;
- total births/deaths/kills;
- diet fractions;
- trait mean/spread;
- children;
- focus members;
- open tree;
- population chart.

## 13. Timeline

Markers:

- intervention;
- speciation;
- extinction;
- predation milestone;
- boom/crash;
- mass extinction.

Dragging timeline only selects time; explicit action starts rewind.

## 14. Tree

Use normal web SVG/canvas, not world Pixi scene.

Requirements:

- pan/zoom;
- time axis useful;
- status distinction beyond color;
- node click -> species inspector;
- current species focus.

Start simple; do not block MVP on sophisticated phylogenetic layout library.

## 15. Charts

Minimum global:

- population;
- species count;
- plant biomass.

Species:

- population;
- mean size;
- mean speed;
- mean diet.

Use low-frequency stats, never render stream.

## 16. Mobile

- CSS safe-area insets;
- 44px+ touch targets;
- compact top bar;
- bottom sheets for inspector/tools/timeline;
- only one major sheet at once;
- world remains visible.

## 17. Accessibility

- keyboard-accessible DOM controls;
- labels on icons;
- reduced-motion UI preference;
- color not sole status signal;
- numeric summaries for charts.

## 18. Development debug overlay

Toggle via query/dev settings:

- spatial grid;
- environment grid;
- vision cone;
- sensed target line;
- velocity;
- plant gradient;
- IDs/species;
- NN input/output;
- tick phase timing.

This is mandatory for tuning.

## PART C — PERSISTENCE

## 19. IndexedDB

Use IndexedDB, not localStorage, for worlds.

Suggested DB: `eon-worlds-v1`.

Stores:

- `worlds` manifests;
- `snapshots`;
- `commandChunks`;
- `events`;
- `stats`;
- `preferences`.

## 20. Manifest

```ts
interface WorldManifest {
  worldId: string;
  worldName: string;
  createdAtIso: string;      // metadata only
  lastOpenedAtIso: string;   // metadata only
  seed: number;
  appVersion: string;
  engineVersion: string;
  configSchemaVersion: number;
  snapshotSchemaVersion: number;
  latestTick: number;
  latestSnapshotId: string;
  parentWorldId?: string;
  branchTick?: number;
  status: "ok" | "crashed" | "legacy" | "corrupt";
}
```

Wall-clock metadata excluded from authoritative hash.

## 21. Snapshot header

```ts
interface SnapshotHeader {
  magic: "EONSNAP";
  schemaVersion: number;
  engineVersion: string;
  seed: number;
  tick: number;
  configHash: string;
  payloadChecksum: string;
}
```

Payload stores typed arrays and PRNG state losslessly.

No class prototype serialization.

## 22. Snapshot cadence

Initial hypothesis:

- durable autosave roughly every 10,000 ticks;
- manual save immediate;
- intervention may mark dirty but not necessarily full snapshot;
- monitor quota.

Tune based on snapshot size and rewind cost.

## 23. Command log

Every accepted player command append-only, sorted by tick/sequence.

Engine random outcomes are not commands because snapshot PRNG state + deterministic rules recreate them.

## 24. Replay

To reconstruct tick T:

1. latest compatible snapshot S <= T;
2. load S;
3. load commands after S through T;
4. headless step without rendering;
5. stop at exact T;
6. optional verify known hash.

## 25. Save round-trip invariant

Must pass:

```text
run 10,000 uninterrupted
==
run 2,500 -> snapshot -> deserialize -> run 7,500
```

Authoritative hash identical.

## 26. Worker/storage boundary

Preferred:

- pure engine serializes abstract state;
- Worker host/persistence adapter writes IndexedDB;
- browser APIs stay out of engine.

IndexedDB can be used from Worker in modern web environments, but if a target WebView behaves poorly, move DB calls to main thread without changing engine format.

## 27. Checksums and safe load

Load validates:

- magic;
- schema;
- engine compatibility;
- checksum;
- array lengths;
- config hash.

On failure:

- do not delete;
- preserve older snapshots;
- mark world status;
- clear error message to user/developer.

## 28. Engine compatibility policy

Schema compatibility != simulation compatibility.

MVP can require exact compatible engine semantics.

If old behavior is incompatible, mark as legacy rather than replaying a different history while pretending it is the same.

## 29. Rewind preview

Flow:

1. pause present;
2. ensure present restorable snapshot/state;
3. reconstruct target;
4. enter visible HISTORICAL PREVIEW;
5. inspect only;
6. return present or create branch.

No environmental commands in preview.

## 30. Branch

A branch is a new world:

```text
parentWorldId = source
branchTick = T
seed/config inherited
snapshot = exact state at T
new command history continues from T
```

Original never changes.

A branch with no new commands must reproduce control history.

## 31. Quota/pruning

Never grow snapshots indefinitely.

Possible policy:

- keep latest 10;
- keep sparse older checkpoints;
- never remove manual bookmarks/branch points without user action;
- retain command history required for retained reconstruction.

Time-series stats use downsampling separately.

## 32. Export/import late MVP

Future `.eonworld` standard ZIP container:

- manifest JSON;
- config;
- binary snapshot(s);
- command/event/stat chunks.

Imported files are untrusted: validate size, array lengths, strings, schemas, checksums and ZIP paths.
