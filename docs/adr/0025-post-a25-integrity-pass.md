# ADR 0025 — Post-A25 product integrity and corrective pass

Status: accepted · Date: 2026-08-15 · Engine 0.7.0 → **0.8.0** · Protocol 8 → **9** ·
Config schema 7 unchanged · Snapshot schema 8 unchanged

The final MVP audit (ADR 0024) left two release gates failing and a set of product-flow
findings unaddressed. This pass reproduced every finding against the A22–A25 tip
(`474d926`), fixed what was real, and re-measured. It is one pass with two halves: the
product half (world creation, rewind, branching — findings A–C) and the ecological half
(carnivory reachability, carcass saturation, population cap, speciation — findings D–G).

## 0. Baseline verification

Before changing anything: the A22–A25 branch (`claude/evosim-a22-a25-delivery-t4itkl`)
was fast-forwarded onto this line after verifying it descends from the trunk tip; the
golden fixture suite was re-run green on that tip (all six hashes reproduced); and the
ADR 0021 §5 calibration table was reproduced EXACTLY on a four-seed subset — every
population, cap-refusal, trait-sd, diet and meat number byte-identical — so the
measurements this pass corrects were verified, not trusted.

## 1. The product findings (A–C) and what changed

### A. World creation is a product flow now

The app booted straight into a running simulation of the URL seed; the recovered world
generator lived on a `?view=generator` debug route. docs/01 §9 lists "World list/start"
and "New world" as primary UI states — they did not exist.

Now: the app opens on a **start screen** (New World / Load World). New World previews
maps from a seed — explicit, random, regenerate, all nine environment layers, an
environment summary — with **no engine, Worker or authoritative time existing**.
Create World builds the accepted seed's world, which opens at **exact tick 0, PAUSED**,
with a **tick-0 baseline save** persisted immediately (binding the manifest and arming
autosave — creating a world is an explicit persistence intent; discarded previews are
never persisted). Play is what starts evolution. `?seed=` deep-links into the New World
screen with the seed previewed; it does not skip acceptance.

**Preview identity is proven, not assumed**: `WorldSummaryDto` carries the world's
`environmentHash` (protocol 9), the New World screen displays the previewed map's
digest, the app fails loudly if they ever disagree, a Node test pins two constructions
of the same seed to identical environment/tick-0 state hashes, and the browser E2E
asserts the digest shown on the create screen equals the digest of the world the Worker
built. The `?view=generator` debug tool remains, unchanged, as a developer view.

### B. Rewind is a user workflow

The scrubber offered `[originTick, presentTick]` whether or not any save could reach a
tick (reconstruction needs a save at or before the target, ADR 0018 §7), and released
the pointer straight into a reconstruction — plus, while previewing, the panel's
"present" collapsed to the previewed tick because it read the view engine's telemetry.

Now: the offered range floor is the **earliest stored save** (which, for worlds created
through the New World flow, is tick 0 by construction); a legacy world whose first save
came later gets its unreachable early history **stated** ("History before tick N was not
stored"), never offered. Stored checkpoints are visible, tappable chips. **Dragging only
selects; the explicit `View this time` button reconstructs** (docs/06 §13). The present
tick shown during preview/reconstruction is threaded from the live world's last
telemetry through `HistoricalStatus`, and starting a rewind pauses the UI's speed state
so the time controls tell the truth. Return to present still restores the untouched
live engine (it was never stepped — ADR 0018's two-engine design).

### C. Branching opens the branch

`branchHere` deliberately left the user in the parent's historical preview; the branch
had to be found in the Worlds list by hand, which made the feature look broken.

Now the flow is: persist the branch → leave the preview → **load the branch as the open
world, paused at the branch tick**. A banner names the branch, its parent and the tick;
the Worlds panel carries a standing "This is a branch of X, diverging from tick N" note
and every branch row names its parent; per-world UI state (charts, tree, species
details, selection, event log) resets on every world switch. The host now clears stale
preview state whenever a load replaces the world — previously a LOAD_WORLD issued
mid-preview would have kept reporting the old world's past. Parent isolation was already
enforced by the store (a branch origin can never write over an existing world) and is
covered by session tests either way: after the auto-open, later saves land in the
branch's manifest and the parent's stays byte-identical.

## 2. The ecological findings (D–F): one cause, two levers

ADR 0021 measured all three symptoms and identified the productivity lever; ADR 0024
left pulling it as L11. This pass pulled it — and found that productivity alone was
not enough, because the **food-target policy itself was a structural blocker**.

### 2a. The fitness valley was real (finding D)

docs/04 §20's categorical rule — carcass only when meat efficiency ≥ plant
efficiency — meant a herbivore-leaning organism ignored carrion it was standing on
even on a bare cell. The founder's controller already wires `carcassProximity` into
its eat reflex (+0.40); the policy gate was the single blocker between "herbivore"
and "opportunistic scavenger". Twelve baseline seeds: meat eaten 0 on ten of them,
300 and 103 units on the other two; mean diet pinned at the founder's −0.60.

The rule is now **expected obtainable energy** (docs/04 §20 as amended):

```text
expectedGain(source) = min(bite, locally available) × sourceEnergyPerUnit × ownEfficiency
```

claim the better source; exact ties choose the plant. No role is declared: the diet
gene moves the efficiencies, the local world moves the availabilities. A herbivore on
a rich cell still grazes (its plant gain dwarfs floor-efficiency meat); on a stripped
cell it scavenges rather than starves; a carnivore abandons a nearly-empty carcass for
grass. The carcass query is gated by a full-bite upper bound, so the common
herbivore-on-grass case costs exactly what it did before.

### 2b. Calibration (L11): capacity ×0.7 — MEASURED NUMBERS TO BE FILLED

### 2c. Carcass saturation (finding E) — MEASURED NUMBERS TO BE FILLED

## 3. Speciation (finding G): the split is reachable, and what it took to prove it

Gate 6 asks for a calibrated fragmented/environmentally divergent run that creates an
automatic species split. Getting there took four falsified designs, each of which taught
something worth recording:

1. **A hot barren barrier between two habitable bands** (96×96): the far band was never
   colonized — the founder cannot cross a band it is not yet adapted to — and the single
   populated band boom-crashed to extinction at tick 32 000.
2. **A milder full-map cline** (96×96): survives, but stays ONE continuous cloud. The
   population repeatedly bottlenecks (troughs of ~100), each crash erasing the spatial
   structure a cline needs, and the detector correctly refuses to split a cline — the same
   verdict every reference-world soak has always produced.
3. **The barrier at 128–160 grid**: still either extinct or un-colonized. Fragmentation
   that depends on organisms crossing hostile ground does not happen at these horizons.
4. **The design that works — make the fragmentation happen to an already-spread
   population.** One continent; at tick 8 000 a sequence of ordinary `LowerTerrain`
   intervention commands floods a full-width equatorial channel (the product's own
   geological tool, canonical and replayable); the continent becomes two, with the founder
   lineage already living on both sides.

On the 192×192 scenario world the measured between-deme RMS gene distance is ≤ ~66 Q
before the channel (and in flat controls), then grows monotonically after it — ~180 Q at
20 000, ~430 Q at 35 000, ~500 Q at 40 000 — led by size and diet, with a smaller world
(128) reproducing the same curve until its half-sized demes died out. The scenario's
detector is therefore calibrated at `splitDistanceThresholdQ` = **480** (continuity 160):
2–3× the measured noise ceiling, on the measured divergence trajectory, with the
anti-flicker machinery (five stable analyses, centroid continuity, minimum daughter
population) unchanged in kind. The default 901 stays exactly as calibrated for the
undivided reference world.

**Result: the engine's own detector declares the split at tick ~45 000, and the two
species persist for the next 60 000 ticks** (deme RMS 312–680 Q, divergence in size, diet
and acceleration) until the northern deme's boom-crash trough hits zero at ~105 000 and
the world honestly returns to one species — an extinction the event log records like any
other. Reachability is what the gate asks for, and reachability is what the fixture
(`fixtures/speciationScenario.ts`) plus `ecologicalSpeciation.test.ts` now pin: a split
must occur by tick 60 000 (measured 45 000 + 33% headroom), asserted as a horizon rather
than a brittle tick, on a config whose plant capacities are pinned as absolute values so
DEFAULT_CONFIG retunes cannot shift the world the calibration measured.

## 4. Versioning

- `ENGINE_VERSION` 0.7.0 → 0.8.0: the food-target policy is an authoritative behaviour
  change, and the recalibrated `DEFAULT_CONFIG` changes every world hash. All six golden
  fixture hashes, the populated soak hash and the config digest are regenerated; the
  lifeless environment soak is unaffected by either change and its hash is expected to
  hold (verified).
- `PROTOCOL_VERSION` 8 → 9: `WorldSummaryDto.environmentHash` (diagnostic identity).
- `CONFIG_SCHEMA_VERSION` unchanged: no field was added, removed or reshaped — only
  default VALUES moved, which the config hash captures.
- `SNAPSHOT_SCHEMA_VERSION` unchanged: serialization is untouched. Snapshots from 0.7.0
  are unloadable by the exact-version MVP policy, as every engine bump before this one.
