# ADR 0021 — Milestone 12: performance, memory, calibration and browser E2E

Status: accepted · Date: 2026-08-15 · Engine 0.7.0 unchanged · Protocol 7 → 8 · Tasks L01–L09

Milestone 12 is the measurement milestone. It adds no simulation rule, changes no authoritative
constant and moves no golden hash: `ENGINE_VERSION` stays **0.7.0** and every fixture and soak hash
is reproduced unchanged. What it adds is the ability to _see_ — a benchmark, a phase profile in the
browser, per-category memory accounting, a release-length soak, a twelve-seed calibration study and
the browser end-to-end suite that has been outstanding since Milestone 6.

`PROTOCOL_VERSION` goes 7 → 8 for one addition: `TelemetryDto.memory`, plus `tickPhaseLabels` on
the display block. Both are diagnostics. CLAUDE.md's rule that a UI-only change must never alter an
engine hash is honoured exactly.

## 0. What this milestone deliberately did not do

**It did not retune `DEFAULT_CONFIG`.** §5 measures the carrying-capacity problem across twelve
seeds and identifies the lever, quantitatively, with a named experiment. Applying it is a separate,
larger decision: it is an `ENGINE_VERSION` bump, a regeneration of all six golden fixture hashes and
both soak hashes, and a re-run of every acceptance suite that quotes them. docs/08 §24 asks for the
defaults to be implemented faithfully and tuned afterwards _through named experiments_; this ADR
delivers the experiment and the evidence, and leaves the pull of the lever as an explicit,
costed follow-up rather than a change smuggled into a measurement milestone.

## 1. The benchmark CLI (L01)

```bash
pnpm benchmark:engine --seed 0xE0A12026 --population 5000 --ticks 10000
```

Reports every field docs/07 §9 asks for: version and config digest, runtime and hardware metadata,
ticks per second, mean/p50/p95/max tick, phase totals, peak population, final hash, estimated
memory.

Two decisions are worth recording.

**`--population` is a warm-up target, not a spawn count.** There is no way to conjure 5 000
organisms into a world — population is an ecological outcome, and a benchmark that spawned them
would be measuring a state the simulation never produces. So the run steps the world until it holds
at least N live organisms and only then starts measuring. If the target is not reached within
`--warmup-max` ticks, the report says so in the header rather than quietly measuring 300 organisms
under a heading that claims 5 000.

**The final hash is printed.** A benchmark that made the engine fast and wrong would otherwise look
like a success. The hash is comparable against `pnpm headless` for the same seed and tick count.

The engine still never reads a clock. `performance.now()` is called only in the CLI, between
`step()` calls, and the phase profile arrives through the documented `setProfiler` boundary — the
engine reports where it is, the host decides when that was.

## 2. Memory accounting (L03)

`estimateEngineMemory(engine)` answers the engine's share of docs/07 §11: organism state, genes,
brains, phenotypes, environment, carcasses, spatial index, scratch, species, events, statistics and
commands, plus a total and an occupancy context.

Categories held as TypedArrays are **exact**, read from `byteLength`, and that is the great
majority of the footprint and all of the part that scales. Species records, timeline events and the
command log are ordinary JS objects, so those are **modelled** from documented constants — the
question the number answers is "is this growing without bound, and is it megabytes or gigabytes",
not "does this match a heap snapshot".

The SoA stores are walked generically over their own enumerable typed-array fields rather than by a
hand-written column list, so a column added in a later milestone is accounted for without anyone
remembering to update the accounting. `StatisticsStore` keeps its buffers privately and reports its
own size instead.

A test asserts the property that matters for a diagnostic: measuring a world every tick for sixty
ticks produces the same state hash as never measuring it.

Two categories the engine cannot see are reported by whoever owns them: the render buffer pool
(`RenderBufferPool.allocatedBytes`, exact) and the main thread's chart history (`StatsHistory.length`).

## 3. The performance HUD (L02, L04)

The phase profiler has existed since Milestone 6 — engine hooks, host timing, `phaseMillis` on
telemetry — and nothing displayed it. A profile nobody can read is not instrumentation, so the
development overlay now carries a Performance panel: mean tick against the docs/07 §8 budgets,
the phase breakdown sorted by cost, frame rate and draw counts, transport health, and the memory
report by category.

It is a projection at telemetry cadence. Renderer counters are **pulled** at 2 Hz while the panel
is open and not polled at all while it is closed — frame rate changes sixty times a second and
React must never see that stream (CLAUDE.md React boundary).

Budget colour is never the only signal: the headline spells out "within target" / "above target" /
"over budget" beside the number, per docs/06 §17.

`tickPhaseLabels` joins `WorldDisplayDto` for the same reason every other label array is there: the
names live in the engine, the UI cannot import the engine, and the Worker is the one place that
legitimately imports both.

### Render performance: measured, and the finding (L04)

Two measurements, deliberately in different places.

**Node, `pnpm benchmark:engine --population 5000 --ticks 5000`** on the delivery container (4× Xeon
@ 2.8 GHz, Node 22):

```text
warm-up    target 5000 organisms, 11118 ticks, reached
measured   5000 ticks in 304.8s = 16.4 ticks/s
tick cost  mean 60.958 ms | p50 62.502 ms | p95 75.826 ms | max 108.546 ms
population start 5006 | end 6446 | peak 8192
phases     sensing 52.1% | movement 21.8% | brain 20.0% | metabolismDeath 3.2% | feeding 1.1% | rest < 1%
memory     11.00 MiB engine total, 947 B per organism slot x 8192 slots
```

**Chromium, the `performance.spec.ts` browser pass** at MAX with 1 226 organisms:

```text
tick       5.60 ms mean, within target (target 25 ms, limit 50 ms)
achieved   78.9 TPS
render     15 FPS, 66.6 ms/frame, 1134 drawn, 0 detailed
transport  1 buffer in flight, 0 dropped
phases     sensing 52% | movement 25% | brain 14% | renderSnapshot 10%
```

Four findings.

1. **The hotspot is sensing, and it is the same hotspot in both environments.** 52% in Node at
   5 000–8 192 organisms and 52% in a browser at 1 200 — a stable structural cost, not an artefact
   of one runtime. Movement and brain follow. Every other phase together is under 10%.

   The mechanism is three independent range scans per organism per tick — nearest visible creature,
   nearest visible carcass, and the crowding count — each sweeping a block of spatial cells sized by
   the query radius. With `spatialCellSizeLU = 32` and vision up to 96 LU that is up to 7×7 cells
   twice plus 3×3 for crowding, roughly a hundred cell visits and their occupant-list walks per
   organism per tick.

   docs/07 §10 puts "spatial queries" third in the optimization order, right after profiling and
   allocation removal. The obvious first move is that **the crowding count's cell block is a strict
   subset of the vision block** whenever vision radius ≥ crowding radius, so it can ride the
   creature scan's walk instead of repeating it. That is a behaviour-preserving change with a hard
   gate — the golden hashes must not move — and it belongs in its own change, not in the milestone
   that discovered it.

2. **Render pooling and LOD are working, so neither needs changing.** Zero dropped snapshots and one
   buffer in flight over the whole run: back-pressure never engaged. Zero organisms on the detail
   layer at world zoom, which is exactly right — at that zoom a body is under a pixel and docs/06 §3
   puts it in LOD 0, "point, tint only". The detail layer is already viewport-culled.

3. **Culling the particle layer is therefore not justified**, and docs/07's Milestone 12 line says
   "LOD/culling/buffer pooling **if justified**". At world zoom nothing is off-screen to cull; when
   zoomed in the layer is a single batched draw whose per-frame CPU cost is one pass over snapshot
   columns the renderer must read anyway. Adding a bounds test per organism would spend CPU to save
   GPU work that is not the constraint. CLAUDE.md: optimize measured hotspots only.

4. **The 66.6 ms frame is a software rasteriser, not a verdict on the renderer.** Headless Chromium
   in this container has no GPU and falls back to SwiftShader, while the simulation runs at MAX on
   the same four cores. The number is recorded because it is what was measured, and it is explicitly
   not compared against docs/07 §8's 16.7 ms target, which is about hardware that exists. The
   Milestone 6 browser pass on a real GPU measured 75–92 TPS at MAX with ~1 280 organisms and a
   responsive UI (ADR 0010), which is the comparable figure.

The Node mean tick of 61 ms at 5 000–8 192 organisms is above docs/07 §8's 50 ms limit — on a shared
2.8 GHz cloud vCPU, which is not the "modern desktop" the budget is written for. docs/07 §8 forbids
turning that into a pass/fail, so it is recorded, not asserted. What it does say is that the sensing
finding in (1) is worth acting on.

## 4. Long soak (L06)

docs/07 §6 asks for 100 000 ticks routinely and 1 000 000 nightly or manually before release. The
100 000-tick run stays a Vitest test because it fits inside `pnpm verify`; the million-tick run is a
CLI (`pnpm soak:long`) because it does not, and because docs/07 §8 forbids turning a wall clock into
a pass/fail signal.

The important structural change is that they are now **the same soak at two lengths**. The world
definition and the whole invariant sweep moved into `packages/engine/src/fixtures/soakWorld.ts`,
which both use, so a rule added to either is added to both. The environment invariants — per-cell
capacity, growth remainder range, vegetated water — moved from a single end-of-run check into the
per-sweep sweep, which is strictly stronger: a cell that overfilled at tick 400 000 and drained
again by the end used to pass.

The CLI prints a state hash at every power-of-ten tick, so two runs are comparable line by line and
a divergence can be bisected in a handful of steps instead of by re-running the whole million. It
exits non-zero on any violation, a failed snapshot round trip, or a restored world that does not
continue identically, so it is usable unattended.

## 5. Twelve-seed calibration (L07)

docs/07 §14: "Run 10–30 seeds for important tuning conclusions. Do not tune from one lucky seed."
Three findings have been carried forward since Milestone 4 waiting for exactly this study — the
population cap (ADR 0006 §7), carnivory (ADR 0008 §5a) and the carcass cap (ADR 0008 §5b). Here it
is, on twelve seeds.

**The suite.** `FIXTURE_SEED + i × 7919` for i = 0…11 — the same family
`world/generateWorld.test.ts` already uses for world-generation calibration, extended by two, so
the calibration seeds are one set rather than three. All twelve produce valid worlds on the first
generation attempt.

```bash
pnpm sweep --seeds 0xE0A12026,0xE0A13F15,…,0xE0A2746B --ticks 10000 --csv
```

| Seed         | Final pop | Peak      | Cap refusals  | Max gen | Trait sd | Biomass | Mean diet | Meat eaten |
| ------------ | --------- | --------- | ------------- | ------- | -------- | ------- | --------- | ---------- |
| `0xE0A12026` | 4 364     | 4 364     | 0             | 8       | 0.0556   | 78.8%   | −0.597    | 0          |
| `0xE0A13F15` | 3 897     | 3 897     | 0             | 7       | 0.0306   | 79.7%   | −0.607    | 0          |
| `0xE0A15E04` | 4 851     | 4 851     | 0             | 8       | 0.0370   | 68.4%   | −0.580    | 0          |
| `0xE0A17CF3` | 4 738     | 4 738     | 0             | 8       | 0.0718   | 75.7%   | −0.607    | 0          |
| `0xE0A19BE2` | 6 682     | 6 682     | 0             | 10      | 0.0578   | 61.6%   | −0.598    | **300**    |
| `0xE0A1BAD1` | **8 192** | **8 192** | **519 388**   | 8       | 0.0407   | 66.0%   | −0.618    | 0          |
| `0xE0A1D9C0` | 3 619     | 4 449     | 0             | 8       | 0.0497   | 66.8%   | −0.597    | 0          |
| `0xE0A1F8AF` | 7 356     | **8 192** | **939 849**   | 8       | 0.0301   | 53.5%   | −0.601    | 0          |
| `0xE0A2179E` | **8 192** | **8 192** | **1 640 091** | 8       | 0.0428   | 54.2%   | −0.599    | 0          |
| `0xE0A2368D` | 432       | 4 914     | 0             | 8       | 0.0437   | 77.4%   | −0.650    | 0          |
| `0xE0A2557C` | 5 461     | 5 461     | 0             | 9       | 0.0506   | 71.6%   | −0.589    | **103**    |
| `0xE0A2746B` | 5 876     | **8 192** | **22 537**    | 10      | 0.0290   | 67.1%   | −0.596    | 0          |

Trait sd is the per-gene standard deviation as a fraction of a gene range; founders start at exactly
0.0000, so every value in that column is variation mutation produced.

### 5a. Survival and population — the release gate is met at the median and missed on a third of seeds

**12/12 survive.** Median final population 5 156, median peak 5 188 — sitting almost exactly on the
docs/07 §7 desktop design target of 5 000 organisms. On that measure the defaults are well
calibrated.

**4 of 12 seeds reach the 8 192 cap by tick 10 000**, refusing 22 537 to 1 640 091 births. docs/01
§12 makes "population does not normally slam into engine cap" an MVP release gate, and a third of
seeds is not "does not normally".

It is worse than a third, and the table says why: **population is still rising at tick 10 000 in 8
of 12 seeds** (peak equals final). Ten thousand ticks is not equilibrium, so 4/12 is a _lower_
bound on how many worlds eventually hit the cap. ADR 0006's six-seed sample found 3/6 — on a
different seed family, at the same horizon, on engine 0.4.0. Two independent samples agree that
this is roughly half the worlds, not a quirk.

**And the cap costs diversity, measurably.** Mean trait sd across the four capped seeds is **0.0357**;
across the eight uncapped seeds it is **0.0509**. Capped worlds carry about **30% less** inherited
variation. docs/01 §11 warns that a hard cap biases evolution because refusal is by iteration order
rather than by ecology; ADR 0006 saw it on one seed; twelve seeds confirm it as a population-level
effect.

### 5b. The lever, measured

The cause is not reproduction and not the cap itself — it is productivity. The reference world
carries 168.8M plant capacity regrowing at roughly 1.2% per environment update, which feeds an
equilibrium population several times the design target. The single-dimension lever is therefore
`plants.baseCapacityByBiome`.

Named experiment `experiments/carrying-capacity.json`, variant `capacity-half`: every non-water
biome's base capacity halved, nothing else touched.

Run on the reference seed plus the three seeds that were pinned at or reached the cap:

| Seed         | Population (base → half) | Cap refusals (base → half) | Meat eaten (base → half) | Carcasses skipped (base → half) |
| ------------ | ------------------------ | -------------------------- | ------------------------ | ------------------------------- |
| `0xE0A12026` | 4 364 → 1 118            | 0 → 0                      | 0 → **320**              | 4 751 → **0**                   |
| `0xE0A1BAD1` | 8 192 → 5 201            | 519 388 → **0**            | 0 → **17 294**           | 16 673 → 6 733                  |
| `0xE0A2179E` | 8 192 → 3 887            | 1 640 091 → **0**          | 0 → 0                    | 20 996 → 6 409                  |
| `0xE0A2746B` | 5 876 → 3 215            | 22 537 → **0**             | 0 → 0                    | 25 115 → 8 534                  |

**The lever works, on all three symptoms at once.** Cap refusals go to zero on every seed that had
them. Carrion overflow falls by 2.5–4× and disappears entirely on one seed. And carnivory appears
where it had never appeared: seed `0xE0A1BAD1` ate **17 294** units of meat against zero at
baseline — one seed in four now has a lineage living partly on carrion, which is the first time
this project has seen that emerge rather than be handcrafted.

**And 0.5 is too strong a factor.** The reference seed lands at 1 118 organisms, a fifth of the
docs/07 §7 target of 5 000; the other three land at 3 215–5 201, which is the right neighbourhood.
Mean trait sd over the four seeds drops from 0.0420 to 0.0359 — a smaller population carries less
standing variation, which is a real cost and not one to trade away by accident.

So the conclusion is _not_ "set the factor to 0.5". It is:

1. the productivity lever is confirmed at n = 4 to fix the release-gate violation and to unlock
   carnivory, and
2. the factor itself needs its own calibration pass — a sweep over roughly 0.6–0.8 across the full
   twelve seeds, scored on final population against the 5 000 target, on cap refusals, on trait sd
   and on whether carnivory survives.

That pass is the follow-up §0 declines to fold into a measurement milestone: it ends in an
`ENGINE_VERSION` bump and regenerated goldens, and it deserves its own gate.

### 5c. Carrion is capped structurally, not occasionally

**All 12 seeds saturate `limits.maxCarcasses` (4 096 live), skipping between 4 751 and 28 929
carcasses.** This is not seed-dependent and not a tuning question in the way population is: at the
documented decay rate a carcass survives roughly 8 000 ticks, so any world losing about one organism
per tick accumulates toward twice the cap. The behaviour at the cap is correct by specification —
a deterministic skip plus a hashed counter, never an eviction — but the suppressed carrion is
exactly the resource §5d says nothing is eating.

### 5d. Carnivory is reachable, and barely reached

ADR 0008 §5a reported no meat eaten in 10 000 ticks of the reference world and left "carnivory
impossible" on the docs/07 §12 watch list. Twelve seeds refine that: **2 of 12 ate meat** — 300
units on `0xE0A19BE2` and 103 on `0xE0A2557C`. So it is not impossible; it is marginal.

Mean diet is the reason. Across all twelve seeds it stays between −0.580 and −0.650 against a
founder value of −0.600 — after eight to ten generations, selection has not moved the population's
diet at all. docs/04 §20 only sends an organism to a carcass when meat digests at least as well as
plants, and with plants at 53–80% of a very large capacity, they never do. The carrion cap (§5c)
compounds it: the resource that might reward a carnivore is being thrown away.

The three findings are one finding: **the world is too productive.** Plants are abundant enough to
push population into the cap, abundant enough that meat is never worth eating, and the resulting
death rate is high enough to overflow the carcass store. That is why §5b tests one lever rather
than three.

## 6. Browser end-to-end (L08, L09)

CLAUDE.md's toolchain policy says to add Playwright once the first interactive vertical slice
exists. That became true at Milestone 6 and has been outstanding since (ADR 0010 §2). It lands here
because a performance milestone's claims have to be checkable in a real browser.

All ten docs/07 PART E flows are covered: explicit-seed world, pause/resume, speed change,
selection and inspector, intervention producing an event, save and reload, species tree, rewind,
branch, and a mobile viewport doing pan, zoom and the one-sheet rule.

**What they do not do is assert simulation outcomes.** No population count, no hash, no species
story. Determinism is proven exactly in Node by the golden fixtures; re-asserting it through a
browser would add flake without adding evidence. What a browser can prove — that a real Worker,
a real WebGL canvas and real IndexedDB work together — is what these tests prove.

Two smaller decisions: `retries: 0`, because a retry hides a real flake; and `vite preview` rather
than `vite dev`, so the suite exercises the production bundle that actually deploys, including its
Worker chunking.

The browser matrix is built by probing which browsers are installed, so a machine with one browser
runs one project instead of failing five ways.

**All three browsers pass on the delivery container**: Chromium 130 (10 scenarios plus the two
mobile-viewport ones), Firefox 153 (10) and WebKit 26.5 (10) — 32 tests green against the production
build. WebKit needed `npx playwright install-deps webkit` first; the browser binary downloads fine
but the image ships without GTK4, GStreamer and the rest of its runtime libraries, and the failure
mode before installing them is a launch error rather than a test failure.

The suite found one real defect, which is the whole argument for it: **the History panel had no CSS
at all**, so it rendered as an in-flow section at the document origin — underneath the
absolutely-positioned top bar, whose buttons intercepted every pointer event over the rewind
scrubber. Rewind was unreachable with a mouse on a desktop viewport and no jsdom test could have
seen it, because jsdom has no layout. It is now positioned as the lower half of the same left column
the Worlds panel occupies, with a 44 px-tall scrubber track per docs/06 §16's touch-target rule, and
it becomes a second sheet above the Worlds sheet on narrow viewports.

## 7. Downsampling (L05)

Already delivered, on both sides, and re-verified here rather than re-implemented: the engine's
`StatisticsStore` keeps multiresolution tiers with a hard retention bound (docs/05 §11), and the
UI's `StatsHistory` does the same over the telemetry stream. Milestone 12 adds the assertions that
tie them to the memory watch: fifty thousand samples occupy exactly the same buffers as none, and
each sampled species costs exactly one ring however often it is sampled.
