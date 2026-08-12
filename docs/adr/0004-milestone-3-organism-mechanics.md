# ADR 0004 — Milestone 3: organism mechanics

Status: accepted · Date: 2026-08-12 · Engine 0.2.0 → 0.3.0 · Tasks D01–D13

Milestone 3 puts life into the world: a Structure-of-Arrays organism store, a 16-gene ecological
genome with derived phenotype, a spatial hash, twenty sensors, the quantized 20→12→5 network with
skip connections, a calibrated founder, movement with terrain and soft collisions, plant feeding
with proportional claims, metabolism, growth, thermal stress, aging and death. Phases 2–9 and
12–13 of the docs/03 §7 tick order now run.

Explicitly not in scope and not implemented: reproduction, mutation, carcasses, predation and
species analysis (Milestones 4, 5 and 8).

## 1. The founder as specified could not eat, and starved every time

This is the substantive deviation of the milestone, so it comes first.

docs/08 §18 encodes `carcassProximity` as **-Q when no carcass is in range**, which is the whole
time before Milestone 5 and most of the time afterwards. docs/08 §20 then gives the founder's eat
output a **+0.40 weight on that input**. The two are individually reasonable and jointly fatal: the
"bonus for nearby carrion" acts as a permanent −0.40 tax on the eat drive.

Measured on the reference world (seed `0xE0A12026`, DEFAULT_CONFIG) with the specification followed
literally:

```text
eat raw   = +0.10 (bias) + 1.20 × localPlant + 0.40 × (-1.00 carcassProximity)
eat output = 0.354   against a threshold of 0.55
```

The founder never once attempted to feed. All 256 starved by tick ~600, on a world at 50% of its
plant carrying capacity. That is the "founder cannot find food" failure mode of docs/07 §12,
reached not by bad luck but by construction.

Three fixes were available:

1. change the sensor so absence reads 0 rather than -Q;
2. lower the global `eatOutputThresholdQ`;
3. recalibrate the founder's eat bias.

**(3) was chosen.** (1) would break the encoding's own logic — a creature at the very edge of
vision reads -Q and absence is "further than that", so a 0 for absence would sit _above_ a distant
sighting and invert the ordering. (2) changes a rule every organism that will ever live is bound
by, in order to fix one genome. (3) touches an ordinary inheritable weight, which mutation can move
in either direction, and docs/07 §15 and docs/08 §21 explicitly anticipate founder calibration.

The bias is `+1.10`, decomposed in the source as:

| Component | Purpose                                                            |
| --------- | ------------------------------------------------------------------ |
| +0.10     | the bias docs/08 §20 intends                                       |
| +0.40     | cancels the carcass sensor's absent state, restoring it to a bonus |
| +0.60     | puts the feeding floor at 25% of a cell's carrying capacity        |

The 25% floor is a calibration choice, and the reason for it is ecological rather than aesthetic.
At the specification's implied floor of 50%, the founder sits exactly on the initial biomass
fraction (`initialBiomassFractionQ` = 0.50): it would eat on the first tick, drop the cell below
half, and stop. Grazing would then be pinned to the regrowth rate from the first tick of the world,
which is both fragile and uninteresting. At 25% the cohort has a real standing crop to work
through, depletes its neighbourhood, and has to disperse — and it still stops well before stripping
a cell bare, so the cell recovers.

Outcome on the reference world: the cohort grows to full development by tick ~1000, still holds
225 of 256 alive at tick 6000, loses 31 to starvation over its lifetime, and the remaining 225 die
of old age at tick 6100. Viable but mediocre, with real competition — which is what docs/07 §15
asks for.

Everything else in docs/08 §§19–20 is implemented verbatim.

## 2. Two units the specification does not name

**Velocity units.** Positions are integers in sub-units (256 per LU, docs/03 §3), but the slowest
genome moves 0.035 LU/tick — nine sub-units. A velocity quantized to whole sub-units would truncate
most of a slow organism's motion to zero and systematically penalize low speed genes, which is a
selection pressure invented by the number format rather than by ecology. Velocities are therefore
stored in **1/256 sub-unit per tick**, and each organism carries the leftover fraction of its step
in `posFracX`/`posFracY`. Over any 256 ticks the displacement is exactly the velocity, in both
directions — there is no floor-versus-truncate drift, and a test pins that.

`organism.geneRanges` states every range in these engine units rather than in the human units of
docs/08 §7, so nothing has to be converted at runtime.

**`FOV_COS_SCALE`.** The visibility test compares squared quantities so it needs no square root per
candidate, and at full `TRIG_SCALE` precision the product would reach ~2.6e18 and lose exactness
above 2^53. The cached half-FOV cosine is therefore scaled by 256, bounding the worst case at
~1.6e14. The cost is a fraction of a degree at the FOV boundary.

## 3. Deterministic roots and powers

docs/08 §7 asks for nonlinear gene responses (size^1.35, speed^1.25, vision^1.4) and permits a LUT.
`Math.pow` and `Math.sqrt` are implementation-approximated by ECMA-262, exactly like `Math.sin`
(ADR 0001 §2), so neither can appear in authoritative code.

`math/isqrt.ts` provides an exact integer square root — bit-length seed, integer Newton, explicit
correction — and `powQ`, which applies the integer part of the exponent by repeated multiplication
and the fractional part by binary decomposition over successive square roots. It is exact at the
endpoints, monotone, and tracks the real power to well under 1% of Q. A LUT was not needed: `powQ`
runs once per birth, not per tick.

`isqrt` is also the movement phase's workhorse (velocity magnitudes, separation distances) and is
called a few times per organism per tick.

## 4. Additions to authoritative state

Beyond the docs/03 §6 array list, the organism store carries:

- `posFracX`, `posFracY` — the velocity remainder described above;
- `developmentQ` — realized development, which docs/04 §4 requires to be able to lag its target but
  which the array list omits;
- `waterTicks` — the drowning grace counter of docs/03 §12;
- `deathsByCause`, `totalDeaths`, `totalBirths` — docs/02 §9 lists statistics accumulators as saved
  state, and a counter that reset on reload would let a future boom/crash event depend on when the
  player last saved.

All are hashed and serialized. The phenotype cache is **not**: it is a pure function of genome plus
config and is recomputed for every live slot on restore (docs/10 §8), so a stale cache in a save
cannot disagree with the genome it claims to describe.

## 4a. The plant gradient cache had to go

Milestone 2 cached the plant gradient in two `Int16Array`s on `EnvironmentStore`, refreshed by the
environment update every 20 ticks. That was sound while nothing changed biomass between updates.
Organisms graze every tick, so it stopped being sound the moment they arrived, in two ways:

- the value organisms sensed was up to 20 ticks stale — a cell grazed to nothing still advertised
  a strong gradient toward itself;
- **a snapshot restore recomputed it from the current biomass**, so a resumed run sensed a
  different world than the continuous one and its state hash diverged. The divergence was invisible
  when the snapshot happened to be taken on a multiple of the environment interval, which is why
  the first version of the resume test passed at tick 3000 and failed at tick 250.

docs/10 §17 names this trap exactly: a cache that can influence future state must be hashed or
provably recomputable, and this one was neither.

The fix computes the gradient where it is consumed (`plantGradientXQAt` / `plantGradientYQAt`),
which makes it a pure function of the biomass field: always fresh, never serialized, nothing to
keep in sync. It is also cheaper — a handful of reads per organism per tick against a 65 536-cell
sweep every 20 ticks — and it cut the 100 000-tick soak from 80 s to 33 s. Sensing still runs
before feeding in the tick order, so every organism reads one coherent snapshot of the field
(docs/03 §9).

Storing the cache in the snapshot was the alternative. It was rejected because it preserves the
staleness as a permanent modelling accident and adds 256 KB to every save to do it.

## 5. Slots, identity and the free list

Slots come from a LIFO stack of released slots, falling back to a fresh slot beyond the high-water
mark. Entity IDs are monotonic, never reused, and 0 is invalid.

Released slots are **cleared**, not left stale. Nothing reads a dead slot, but leaving old bytes
there would make the state hash depend on the history of the dead and force snapshots to preserve
garbage to stay bit-identical.

The state hash and the snapshot both cover only the used prefix `[0, slotHighWater)`, with the
high-water mark itself hashed so the stream stays unambiguous. That keeps hashing proportional to
the population rather than to the 8192-slot capacity — at 256 organisms it is a 32× saving on the
brain weight array alone.

The free list is serialized **verbatim**. Reconstructing it by scanning for dead slots would
produce a different reuse order, and the first birth after a load would land in a different slot
and diverge (docs/10 §18). A test snapshots a world with a non-empty free list and asserts the next
slot handed out matches on both sides.

## 6. Order independence where it matters

Three places could have let storage order leak into outcomes, and each is handled explicitly:

- **Feeding.** Claims are aggregated per environment cell, satisfied in full if the cell can afford
  it, otherwise allocated proportionally with the integer remainder going to the **lowest entity
  IDs** — not the lowest slots, because slots are recycled and carry the accident of who died
  recently. Claimants are reached through a per-cell chain built during the claim phase, so the
  work is proportional to the number of eaters rather than to cells × population (docs/10 §12).
- **Soft collisions.** Each pair is visited once, by its lower slot, and corrections accumulate in
  scratch before being applied. Integer addition is exact and commutative, so the result does not
  depend on visit order; a test asserts a pair resolves identically whichever slot each organism
  holds.
- **Vision.** Ties break on lower squared distance, then lower entity ID. A test swaps two
  equidistant candidates' IDs and asserts the winner swaps with them.

## 7. Judgement calls worth recording

- **Water is slow AND expensive.** docs/03 §11 places the "environment movement multiplier" between
  the velocity update and integration. Applying it to the stored velocity would have made swimming
  _cheap_: movement energy is quadratic in the speed fraction, so a 4× cost multiplier on a 16×
  smaller number is a discount for drowning. The multiplier therefore scales the **displacement**
  while `vx`/`vy` keep meaning propulsive effort, which is what the movement cost is billed from.
- **Severe thermal stress** needed a threshold that docs/04 §8 does not give. Damage begins once
  the excess equals one whole tolerance width (stress ≥ Q) and rises linearly to the configured
  maximum at the 2Q cap. Below that, thermal stress only raises the basal cost.
- **Growth is billed after upkeep.** An organism that cannot pay to stay alive has nothing left for
  getting bigger, and its development lags instead (docs/04 §4).
- **The growth target can dip by one Q unit** where the integer smoothstep truncates. It is
  harmless — development only ever moves toward a _higher_ target — and rounding the smoothstep to
  remove it was rejected because the same function generates the world's noise fields.
- **Founders spawn as newborns**, at the birth size fraction with age 0. Spawning them as adults
  would have skipped the growth cost, which is a hidden survival bonus in all but name. The
  consequence is a synchronized cohort that dies of old age together at tick 6100; reproduction
  will break that up in Milestone 4.
- **Soft collisions read the pre-movement spatial index** (the tick order rebuilds the post-movement
  index in the phase after). A tick's displacement is a fraction of an LU and bodies are at most
  4.5 LU in radius against 32 LU cells, so the 3×3 neighbourhood still covers every overlapping
  pair with a wide margin.

## 8. Performance

Measured on the development machine, worst case: 5000 organisms packed at founder density.

| Phase                     | ms/tick | Share |
| ------------------------- | ------: | ----: |
| sense                     |   13.52 | 46.4% |
| brains                    |    8.09 | 27.7% |
| terrain + soft collisions |    4.49 | 15.4% |
| movement                  |    1.14 |  3.9% |
| metabolism                |    1.10 |  3.8% |
| feeding (build + resolve) |    0.61 |  2.1% |
| spatial rebuilds          |    0.20 |  0.7% |
| deaths                    |    0.02 |  0.1% |
| **total**                 |   29.17 |       |

Against the docs/07 §8 budget that is inside the 50 ms hard requirement and above the 25 ms ideal,
in a configuration deliberately harsher than a real world (5000 organisms crowded into a
1200 LU circle rather than spread over a landmass). The reference 256-organism world runs 10 000
ticks in 8.6 s, about 0.86 ms per tick, and the 100 000-tick soak takes 33 s.

Two optimizations were made after measurement, both behaviour-preserving and both verified against
the golden hashes:

- the vision and crowding queries hoist their typed arrays into locals and reject candidates that
  cannot beat the incumbent before paying for the field-of-view test (32.7 → 29.2 ms);
- `SpatialGrid.rebuild` clears only the cells it previously occupied. Blanket-clearing two
  128×128 grids costs 32 768 writes per tick whatever the population is, which dominated the
  100 000-tick soak once the cohort had died out.

No WASM, per the rule that profiling comes first. The measured hotspot is sensing, and the
remaining lever there is algorithmic (merging the vision and crowding passes), not a language
change.

## 9. Versioning

| Constant                  | Change            | Reason                                                                                                                    |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ENGINE_VERSION`          | 0.2.0 → **0.3.0** | The canonical hash stream now includes organisms and genomes, and eight new phases run.                                   |
| `CONFIG_SCHEMA_VERSION`   | 3 → **4**         | New `organism.geneRanges`, a populated `senses` section, `softSeparationStrengthQ` and `thermalStressMinToleranceCentiC`. |
| `SNAPSHOT_SCHEMA_VERSION` | 3 → **4**         | Snapshots carry the organism store, genomes, brains and slot/free-list state.                                             |
| `PROTOCOL_VERSION`        | unchanged (1)     | No wire shape changed.                                                                                                    |

All golden hashes were regenerated. The frozen inventory of hashed config fields grew from 140 to
175 entries.

## 10. Explicitly not done

- **No reproduction, mutation, carcasses, combat or species.** Phases 10, 11, 14, 15, 16 and 17 of
  the tick order remain unimplemented, with their slots marked in `step()`. `attackCooldown` and
  `kills` exist in the store because docs/03 §6 lists them, and stay zero.
- **No renderer.** The task brief permitted extending an "M2.5 debug view" with organism dots, but
  no such view exists in this repository — `apps/web` is still the Milestone 0/1 version shell —
  and creating one would be starting the Milestone 6 renderer, which the same brief forbids. The
  headless runner reports population, mean energy, mean development, plant intake and deaths by
  cause at every checkpoint instead, which is what docs/10 §26 asks for at this stage.
- **The brain still runs every tick for every organism.** docs/07 §10 permits reducing brain
  frequency, but only "if necessary and versioned", and the measurements do not make it necessary.
