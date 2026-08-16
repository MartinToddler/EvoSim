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

### 2b. Calibration (L11): the factor sweep, and why 0.6

Four factors, twelve seeds each, 10 000 ticks, on the NEW feeding rule (the old-policy
baseline was first reproduced exactly against ADR 0021's table on a four-seed subset):

| Variant       | Capped seeds | Median pop | Max peak  | Seeds eating meat | Median meat eaten | Median trait sd |
| ------------- | ------------ | ---------- | --------- | ----------------- | ----------------- | --------------- |
| policy + ×1.0 | **3/12**     | 4 864      | **8 192** | 12/12             | 2 404 449         | 0.0512          |
| policy + ×0.8 | **3/12**     | 4 044      | **8 192** | 12/12             | 1 905 973         | 0.0462          |
| policy + ×0.7 | 0/12 at 10k  | 3 670      | 7 931     | 12/12             | 1 551 180         | 0.0429          |
| policy + ×0.6 | 0/12 at 10k  | 3 234      | 6 874     | 12/12             | 1 237 666         | 0.0429          |

Ten thousand ticks is not equilibrium, so the cap-risk seeds were re-run to 25 000:
**×0.7 fails there** — both risk seeds hit 8 192, one refusing 2.42 million births —
while ×0.6 leaves one transient boom spike on the single worst seed (122 k refusals at
the peak of an overshoot that immediately recedes) and nothing on the others. Against the
pre-fix norm — half the worlds pinned at the cap for the whole back half of their runs —
that is the "exceptional, not defining" the gate asks for. The scavenging column is the
new policy speaking: every seed, at every factor, eats meat at five to seven orders of
magnitude above the old baseline (0–300 units), which is finding D's fitness valley
closed on population-scale evidence.

### 2c. Carcass saturation (finding E): consumption, then persistence — not a bigger box

Three candidate levers were measured head-to-head on the three decisive seeds at 25 000
ticks (capacity ×0.6 throughout):

- **A bigger cap (16 384) is counterproductive.** The natural standing stock at these
  death rates is 13–16 k carcasses; storing it all feeds the food web so richly (3–7 M
  meat eaten) that the REFERENCE seed then slams the organism cap. Carrion is not a free
  reservoir; it is carrying capacity in another form.
- **Faster rot (decay 20 → 48) fixes the population side** — all three seeds: zero
  refusals, peaks under the cap, scavenging intact at 1.7–2.9 M meat — but the standing
  stock still rides the 4 096 cap.
- **decay 96 overshoots**: faster rot intensifies the scavenging race (meat eaten jumps
  to 3.0–4.9 M), and the higher meat throughput feeds a boom that pins the worst seed at
  the organism cap with 2.09 M refusals. The dynamics are non-monotonic; more rot is not
  monotonically less food web.

**The decision: capacity ×0.6 + decay 48, `maxCarcasses` unchanged at 4 096.** On the
regenerated reference fixture the world holds 1 382 live carcasses at tick 10 000 — real
headroom under a cap every previous world saturated — while eating 511 k meat units.
What remains, honestly stated: during mass-death episodes (the boom-crash troughs) the
store still fills and the deterministic skip discards carrion. That is retained
deliberately: the 16 384-store experiment shows that keeping all crash carrion converts
it into runaway carrying capacity, so the skip is functioning as an overflow valve the
population gate depends on. Finding E closes as "calibrated and understood", not as
"warning suppressed": normal operation sits under the cap, saturation is episodic, and
both alternative levers were measured and rejected for cause.

### 2d. The shipped configuration, measured (the after-table)

Twelve seeds, 10 000 ticks, plain `DEFAULT_CONFIG` on engine 0.8.0:

| Measure                              | Before (0.7.0)                  | After (0.8.0)                       |
| ------------------------------------ | ------------------------------- | ----------------------------------- |
| Survival                             | 12/12                           | **12/12**                           |
| Seeds refusing births at the cap     | 4/12 (a floor; 8/12 still rising) | **0/12**, max peak 6 677          |
| Seeds eating meat                    | 2/12 (300 and 103 units)        | **12/12** (median 1 580 620 units)  |
| Carcass store at tick 10 000         | saturated on 12/12, 4 751–28 929 skipped | 7/12 under the cap; 3 seeds zero skips; median 3 082 skipped |
| Median final population              | 5 156                           | 2 699 (leaner by design; equilibria still rising on several seeds) |
| Median per-gene trait sd             | 0.0509 uncapped / 0.0357 capped | 0.0347                              |
| Kills                                | 0                               | 0                                   |

Two honest costs, stated: the leaner world carries somewhat less standing variation
(median sd 0.0347 — smaller populations hold less; ADR 0021 §5b predicted exactly this
trade at 0.5×, and 0.6 + the carrion food web keeps it milder), and active predation
(kills) has still not appeared at 10 000-tick horizons — the demonstrated reachability is
opportunistic scavenging and diet-gene movement (population means to −0.65/−0.84 on
single seeds, deme means to 0.05–0.20 of the gene range in the scenario worlds), with
attack evolution left to longer horizons now that kills finally pay (a kill's carcass is
immediately edible under the expected-gain rule). Attack ATTEMPTS are not instrumented —
only landed kills are observable — noted as a diagnostics gap, not an engine one.

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
  change, and the recalibrated `DEFAULT_CONFIG` (plant capacities ×0.6, carcass decay
  20 → 48) changes every world hash. All six golden fixture hashes, both soak hashes, the
  mutation-golden version stamp (values proven byte-identical) and the config digest
  (`5a63593f0c0f3647`) are regenerated and independently re-verified. The lifeless soak
  moves through the capacity values alone — a lifeless world has no feeder for the
  expected-gain rule to steer.
- `PROTOCOL_VERSION` 8 → 9: `WorldSummaryDto.environmentHash` (diagnostic identity).
- `CONFIG_SCHEMA_VERSION` unchanged: no field was added, removed or reshaped — only
  default VALUES moved, which the config hash captures.
- `SNAPSHOT_SCHEMA_VERSION` unchanged: serialization is untouched. Snapshots from 0.7.0
  are unloadable by the exact-version MVP policy, as every engine bump before this one.

## 5. The final audit matrix

Every original finding, re-reproduced against the A22–A25 tip (`474d926`) before any
change, and re-checked against the final build:

| Finding | Reproduced after A25? | Fix | Regression test | Evidence | Verdict |
| --- | --- | --- | --- | --- | --- |
| World generator disconnected from game flow | Yes — app booted a running sim; generator on `?view=generator` | Start screen + New World screen + explicit Create World | `worldStart.spec.ts` (4 browser scenarios) | E2E green on the production bundle | **PASS** |
| Authoritative time starts before world acceptance | Yes — `initialSpeed: "x1"` at mount | No engine exists before Create World; worlds open at exact tick 0 PAUSED | `worldStart.spec.ts` asserts tick 0 twice 2 s apart, then Play | E2E green | **PASS** |
| Missing tick-0 baseline persistence | Yes — worlds started unbound; autosave armed only after manual save | Create World persists the tick-0 baseline, binds the manifest, arms autosave; discarded previews never persisted | `persistenceSession.test.ts` baseline tests; `worldStart.spec.ts` | Unit + E2E green | **PASS** |
| Unreachable ticks exposed by history UI | Yes — scrubber offered `[originTick, presentTick]` regardless of saves | Scrubber floor = earliest stored save; legacy gaps stated, never offered; checkpoints are chips | `historyPanel.test.tsx` (11 tests) | Unit green; backend `selectSaveForTick` unchanged | **PASS** |
| Pointer-release unexpectedly launching rewind | Yes — `onPointerUp`/`onKeyUp` committed; release at present tick silently paused the world | Dragging only selects; explicit View This Time; rewind pauses the UI speed state; present tick read from `HistoricalStatus` | `persistence.spec.ts` scenario 8 (drag → still Live → button → preview → exact present restored) | E2E green | **PASS** |
| Branch created but not automatically opened | Yes — deliberate "written but NOT opened" comment in App.tsx | createBranch → leave preview → load branch paused at branch tick; banner + standing lineage note; per-world UI state reset | `historicalSession.test.ts` auto-open tests; `persistence.spec.ts` scenario 9 | Unit + E2E green | **PASS** |
| Branch parent isolation | Not broken (store refuses branch-origin-over-parent) — re-verified | Saves after the switch land in the branch's manifest | `historicalSession.test.ts` "keeps later saves inside the branch"; E2E compares the parent's newest save hash before/after | Unit + E2E green | **PASS** |
| Spontaneous carnivory reachability | Yes — 2/12 seeds ate ≤300 units; mean diet pinned at founder | Expected-gain food rule + calibration | `carcassFeeding.test.ts` scavenging tests; shipped-config sweep | 12/12 seeds scavenge (median 1.58M units); diet-gene movement observed; kills still 0 at ≤150k (limitation, §2d) | **PASS** (scavenging) |
| Food-selection fitness valley | Yes — categorical gate at `feedingClaims.ts` | `expectedGain = min(bite, available) × energyPerUnit × ownEfficiency`, plant tie-break, gated carcass query | "lets a herbivore scavenge a carcass on a stripped cell" + 4 more policy tests | Unit green; population-scale effect in §2b | **PASS** |
| Carcass cap saturation | Yes — 12/12 seeds saturated, 4.7k–29k skipped | Calibration (×0.6 + decay 48); bigger store and faster rot measured and REJECTED for cause | Shipped-config sweep | 7/12 under cap at tick 10 000, 3 seeds zero skips, median skips 3 082; reference fixture at 1 382 live | **PASS** (episodic saturation retained as measured overflow valve) |
| Population hard-cap saturation | Yes — 4/12 at 10k (a floor) | Plant capacities ×0.6 | Shipped-config sweep + 25k-tick risk-seed re-runs | 0/12 capped, max peak 6 677; one transient overshoot episode on the worst seed at ×0.6-plain 25k, none with decay 48 | **PASS** |
| Evolutionary diversity / generalist collapse | Partially — capped seeds carried 30% less variation | Cap removed from the ecology; variation now mutation-selection limited | Sweep trait-sd column | Median sd 0.0347; no cap-order filtering remains; leaner-world cost stated in §2d | **PASS** (with stated trade-off) |
| Ecological automatic-speciation reachability | Yes — gate 6 failed; every real run ended one species | Channel-fragmentation scenario (ordinary LowerTerrain commands), detector calibrated from measured noise/divergence | `ecologicalSpeciation.test.ts` (split by tick 60 000; measured at ~45 000, persisting 60k ticks) | Test green on the final build (2 539 s) | **PASS** |

New regressions introduced by A22–A25 found by this pass: none in engine behaviour; the
one A23–A24-era defect encountered (`EON_E2E_BASE_URL` path resolution) had already been
fixed by ADR 0024. New regressions introduced by THIS pass and caught before landing:
the E2E telemetry-placeholder race (fixed in the helpers), the branch-row locator
ambiguity (fixed), and the speciation fixture initially inheriting the retuned decay
(pinned before the fixture ever ran in CI).

## 6. Costs

- `pnpm test` gains the ecological speciation run (~40 minutes standalone) beside the
  100 000-tick soak; both are inherently long determinism tests under docs/07 §8's
  hang-detector policy, and both are the release-gate evidence docs/01 §12 demands.
- The golden fixture suite runs ~2.6× FASTER on the calibrated engine (155 s against
  408 s): the leaner reference world simulates fewer organisms.
