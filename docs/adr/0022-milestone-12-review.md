# ADR 0022 — Milestone 12 review

Status: accepted · Date: 2026-08-15 · Engine 0.7.0 unchanged · Protocol 8 unchanged · Review of ADR 0021

An adversarial pass over everything Milestone 12 added, against the question a measurement milestone
has to answer first: **can any of this change what it measures, and does any of it overstate what it
found?**

**No golden hash moved, and none could have.** Every M12 addition is a read: the memory report walks
`byteLength` on buffers that already exist, the profiler receives two integers per phase boundary,
the HUD polls at telemetry cadence, and the browser suite drives the app through its ordinary UI. The
one change that touches an authoritative code path — moving the golden soak hash into the shared
fixture module — moves a string constant between files. `pnpm verify` reproduces all six fixture
hashes, both soak hashes and the config digest.

## 1. What was checked

| Risk                                                        | Verdict                                         |
| ----------------------------------------------------------- | ----------------------------------------------- |
| Memory accounting perturbs the world it measures            | Clean — asserted by test, per tick, 60 ticks    |
| The SoA walker silently stops counting a moved column       | **Gap, fixed** (§2.4)                           |
| Telemetry's memory walk costs the tick something            | Clean — off the tick path, ~2 Hz, bounded walks |
| Protocol 8 changes an engine hash                           | Clean — diagnostics only, hashes reproduced     |
| The HUD double-counts the whole-tick total as a phase       | **Defect, fixed** (§2.3)                        |
| The long soak checks less than the short one                | Clean — one module, one sweep, and now §2.5     |
| The long soak's sweep cadence drifts                        | **Defect, fixed** (§2.1)                        |
| Calibration claims exceed what twelve seeds support         | Clean — see §3                                  |
| The performance conclusion overstates a container's numbers | Clean — see §3                                  |
| The browser suite can silently stop running                 | **Gap, fixed** (§2.6)                           |
| The browser suite can only ever test a local build          | **Gap, fixed** (§2.2)                           |
| Dead code shipped                                           | **Fixed** (§2.7)                                |

## 2. Findings

### 2.1 The long soak swept twice around every cadence boundary

`scripts/soak.ts` derived its next sweep from `tick % checkEvery`, but a checkpoint lands the engine
on an arbitrary tick — so after every checkpoint the modulo produced a one-tick step, a sweep, and
then another sweep one cadence later. A 3 000-tick run at `--check-every 499` did **17** sweeps where
11 were due.

Not a correctness bug: nothing was skipped, and the extra sweeps found the same nothing. It is a bug
in what the run _costs_, and at a million ticks the sweep is the second most expensive thing in it.
The next sweep tick is now tracked explicitly. Same run, same final hash, 11 sweeps.

### 2.2 The browser suite could only ever test a local build

`playwright.config.ts` hard-coded `baseURL`, so verifying that what is actually _published_ works
meant a manual browser session — the kind of check that quietly stops happening. `EON_E2E_BASE_URL`
now points the suite at any already-served build and skips the local `vite preview` when it is set.

### 2.3 The HUD would have counted the whole-tick total as one of its own parts

`PerformancePanel` excluded the total phase by name (`entry.name !== "total"`). The names arrive from
the Worker in `WorldDisplayDto.tickPhaseLabels`, and the panel falls back to `phase 0`, `phase 1`, …
when they have not arrived — in which case nothing matches `"total"`, the whole-tick measurement
joins the list of its own components, and every phase's percentage is computed against a bar that
includes it. Reachable in the window between a telemetry frame and the world summary. Excluded by
index now.

### 2.4 The memory walker was drift-proof in one direction only

`ownViewBytes` walks a store's own enumerable typed-array fields, which is exactly right for a column
_added_ in a later milestone and silently wrong for one that becomes private — the report would keep
returning a plausible number that was quietly too small. Added a lower bound per category tied to the
organism cap: a walk that found only a handful of columns now fails loudly.

### 2.5 The two soaks agreed, and nothing was checking that they did

The 1 000 000-tick CLI run passes tick 100 000, which is precisely where the Vitest soak stops, and
it printed `a7e2b5e223c8657a` there — the Vitest soak's golden hash, matched by inspection and by
nothing else. The constant now lives in `fixtures/soakWorld` beside the world it describes, the test
asserts it, and the CLI checks it in passing and exits non-zero on a mismatch. "The long soak is the
short soak at scale" is now a claim the tooling enforces rather than a claim an ADR makes.

**The release soak itself ran to completion during this review** (`pnpm soak:long`, 68.7 minutes on
the delivery container):

```text
tick         1 | pop    64 | gen    0 | carrion     0 | 749db58faba882b3
tick        10 | pop    64 | gen    0 | carrion     0 | 119fdb8f57105193
tick       100 | pop    64 | gen    0 | carrion     0 | bc75a7c096fe0b60
tick      1000 | pop    64 | gen    0 | carrion     0 | 8cfb075b8b72ea77
tick     10000 | pop  1718 | gen    8 | carrion  4096 | 4deffe4b6f223a2b
tick    100000 | pop   845 | gen   51 | carrion  1685 | a7e2b5e223c8657a   <- the Vitest golden
tick   1000000 | pop  1472 | gen  328 | carrion  1777 | c0f11ebb61152ef3

sweeps      2013, all clean
population  final 1472 | peak 3223 | trough 25 | max generation 328
lineage     192 376 births, 190 904 deaths, attribution complete, entity IDs monotonic
brains      mean similarity to founder 0.6228, 0.0000% of weights on the clamp
snapshot    round trip exact, continuation identical
memory      9.35 MiB engine total
```

Every one of docs/07 §6's six requirements is answered by that run: no invalid numbers, no count
corruption, no ID collision, no dead-entity leak across **2 013 sweeps**; a snapshot taken at tick
1 000 000 that round-trips exactly and then continues identically for 500 more ticks; and hashes at
every power of ten so a second run is comparable line by line.

Three things in it are worth naming beyond the pass:

- **328 generations**, and the brains are still recognisably descended from the founder controller —
  mean cosine similarity 0.6228, with **0.0000%** of weights sitting on the mutation clamp. docs/07
  §12 lists "mutation destroys brain too fast" as a failure mode to monitor; a third of a thousand
  generations is the deepest evidence this project has that it is not happening.
- **Memory is flat.** 9.35 MiB at tick 1 000 000, against 9.34 MiB at tick 3 000. A million ticks of
  191 000 deaths recycling slots leaks nothing.
- **Still one species**, extending ADR 0013 §9's 100 000-tick finding by an order of magnitude. The
  evolved diversity is a continuous cloud and the detector goes on correctly refusing to split it.

One caveat, stated because the run predates §2.1's fix: it did 2 013 sweeps where the corrected
cadence does ~1 004. That changes what the run cost, not what it checked or what it computed — the
sweep is a pure read, and the 3 000-tick before/after comparison in §2.1 reproduces an identical
final hash.

### 2.6 A suite nobody runs rots

The browser suite was not in CI, which is how the Playwright task stayed open from Milestone 6 to
Milestone 12 in the first place. `verify.yml` gains a Chromium job (plus the mobile viewport) that
uploads its report on failure. Firefox and WebKit stay a local and pre-release run: three browsers is
three times the minutes for a job whose purpose is catching a regression, not surveying engines.

### 2.7 Smaller items

- `BenchProfiler.reset()` was never called. Removed.
- `scripts/sweep.ts`'s usage example named `experiments/mutation-rate.json`, which does not exist. It
  now names the experiment the Milestone 12 calibration conclusion actually rests on.
- `PerformancePanel` re-implements `formatBytes` rather than importing the engine's. That is forced —
  `@eon/ui` depends on the protocol and the renderer's palette and must not depend on the engine —
  and is now documented as a decision rather than left looking like an oversight.

## 3. Claims audited against their evidence

A measurement milestone's real failure mode is a true number with an overstated conclusion. Each
headline claim was re-read against what was actually run:

- **"The hotspot is sensing, at 52%."** Two independent measurements, different runtimes, different
  populations (5 000–8 192 in Node, 1 226 in Chromium), same share to the percentage point. Stated as
  a share of the tick, which is what was measured; no absolute claim is made about hardware the
  benchmark did not run on.
- **"Mean tick 61 ms."** Recorded with the machine named, and explicitly not compared to docs/07 §8's
  50 ms limit, which is written for a modern desktop. The ADR says so in the same paragraph.
- **"66.6 ms per frame."** Recorded, and immediately qualified: headless Chromium here has no GPU and
  falls back to a software rasteriser while the simulation runs at MAX on the same four cores. The
  comparable hardware figure (ADR 0010's 75–92 TPS on a real GPU) is cited beside it.
- **"4 of 12 seeds reach the cap."** True at 10 000 ticks, and the ADR states the bound honestly:
  population is still rising in 8 of 12 seeds at that tick, so 4/12 is a floor, not an estimate.
- **"Capped seeds carry 30% less trait diversity."** Four seeds against eight. Small, and described
  as confirming ADR 0006's one-seed observation at n = 12 rather than as a new independent result.
- **"Halving capacity produces the project's first emergent carnivory."** One seed of four ate 17 294
  units where it had eaten none; a second ate none. The ADR reports both, and does not claim the
  factor is right — it says 0.5 overshoots and names the pass that would settle it.
- **"Culling is not justified."** Rests on zero dropped snapshots, one buffer in flight and zero
  detailed organisms at world zoom, all measured. The claim is scoped to the particle layer; the
  detail layer is already viewport-culled and the ADR says so.

No claim was found to outrun its evidence. The one adjustment is in this document rather than in
0021: the carnivory result is one seed in four, and reads best as _reachable and rare_ rather than as
a solved failure mode.

## 4. What this review did not do

It did not re-run the twelve-seed sweep, and it did not tune `DEFAULT_CONFIG`. Both are the same
decision ADR 0021 §0 records: the calibration pass ends in an `ENGINE_VERSION` bump and regenerated
goldens, and it gets its own gate (tasks L10/L11).
