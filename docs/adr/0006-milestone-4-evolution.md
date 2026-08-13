# ADR 0006 — Milestone 4: asexual reproduction, mutation and evolution

Status: accepted · Date: 2026-08-13 · Engine 0.3.1 → 0.4.0 · Tasks E01–E08

Milestone 4 turns a static cohort into a lineage. Phase 14 of the tick order now runs: eligible
parents pay for offspring, children inherit a mutated copy of genome and brain, generations count
up, and the population finds its own density instead of dying of old age together at tick 6 100.

Reproduction is asexual throughout. No mate choice, no crossover, no dominance, no species
analysis and no predation — those stay out of scope (CLAUDE.md scope exclusions, Milestones 5
and 8).

## 0. Which foundation this was built on

The repository had three divergent lines from the Milestone 2 commit `8aac47b`, produced in
parallel:

| Line                                   | Tip       | Content                            |
| -------------------------------------- | --------- | ---------------------------------- |
| `claude/m3-review-fix-koyqdl`          | `db79e86` | Milestone 3 organisms + its review |
| `claude/evosim-project-setup-ps3fry`   | `73adfa7` | "Foundation gate": M0–M2 hardening |
| `claude/m2-5-review-visualizer-54i8qn` | `1083172` | Milestone 2.5 debug web view       |

Milestone 4 depends on Milestone 3, so this work fast-forwards onto `db79e86`, which is a clean
descendant of `8aac47b`. **The foundation-gate and 2.5 lines are therefore NOT included here.**
That is a deliberate choice, not an oversight, and it has consequences worth stating plainly:

- ADR 0004-foundation-gate (a different ADR 0004 — the two lines both claimed the number) fixes
  six real defects in Milestones 0–2, including a writable public `EnvironmentStore`, a
  `fromSnapshot` that regenerated and discarded the world, an unhashed founder region, and
  unknown config fields entering the world hash. **None of those fixes are in this branch.**
- Merging them here would mean reconciling two independent `ENGINE_VERSION` bumps, two sets of
  regenerated goldens and two conflicting `docs/adr/0004-*.md` files, in a milestone whose brief
  is reproduction. That is a foundation-integration task and it needs its own gate.
- Each of the six defects was re-checked against _this_ branch for whether it threatens Milestone
  4 specifically. None does: reproduction reads and writes only organism state, the snapshot path
  it depends on round-trips correctly here (§8), and no Milestone 4 rule touches the founder
  region or the config surface. The one that comes closest — `fromSnapshot` regenerating the world
  — is wasteful rather than wrong while terrain is immutable, which it is until Milestone 9.

**Recommended next action for the repository owner, independent of Milestone 5:** merge the
foundation-gate line into the Milestone 3/4 line, take the union of both hash-stream changes, bump
`ENGINE_VERSION` once, regenerate every golden, and reconcile the ADR numbering. Doing it before
Milestone 9 (terrain edits) is not optional — that is the milestone at which "restore regenerates
the world" stops being merely wasteful.

## 1. Mutation: one roll per locus, three disjoint outcomes

docs/04 §18 gives three per-gene probabilities — small 0.08, large ~0.005, reset ~0.0002 — without
saying whether they are independent events. They are implemented as one uniform draw in `[0, Q)`
partitioned into disjoint intervals:

```text
roll < resetP                            -> Reset  (fresh uniform gene)
roll < resetP + largeP                   -> Large  (delta at largeSigma)
roll < resetP + largeP + smallP          -> Small  (delta at smallSigma)
otherwise                                -> None
```

Each marginal probability is exactly the configured value — `classifyGeneRoll` is total over the
4 096 possible rolls, and a test counts every one of them rather than sampling — while the outcomes
cannot combine. A gene that was re-rolled from scratch should not also be nudged, and independent
rolls would have allowed exactly that. It is also three times cheaper: one draw per locus instead
of three, which matters at 416 loci per birth.

The partition order is a determinism contract. Reordering the intervals changes which class a
given roll selects and therefore every evolutionary history from the first birth onward.

Brain weights use the same shape minus the reset class. Re-rolling a single connection uniformly
over ±8192 is not a mutation of a controller, it is damage to it, and docs/07 §12 lists "mutation
destroys brain too fast" as a failure mode to avoid.

### Draw accounting

A birth consumes, in this fixed order:

1. two draws for placement (heading, then distance);
2. 16 gene classification draws, plus one `approxNormalQ` (12 draws) per mutated gene and one
   uniform draw per reset gene;
3. 400 weight classification draws, plus one `approxNormalQ` per mutated weight.

Measured at 572 PRNG words for the first birth of the mutation fixture, and pinned by a test that
advances a reference generator word by word until the states match. A change to the count is a
change to every world's future, so it fails loudly rather than silently.

## 2. Sigma units differ between the two blocks

Ecological sigmas are Q fractions of the **normalized** gene range — docs/08 §17 says
`smallSigmaQ` is "0.025 normalized" — so `geneDeltaRaw` scales them onto the raw Uint16 span in a
single expression, multiplying before dividing so a small sigma cannot truncate to zero. The
worst-case product is `6Q × Q × 65535 ≈ 6.6e12`, three orders of magnitude below `2^53`.

Brain sigmas are already in **stored weight units**: `weightSmallSigmaQ = 246 ≈ 0.06 ×
weightScale`, exactly as docs/08 §17 words it. They apply directly through `qmul`.

Two fields with the same `Q` suffix and different meanings is a trap, so both are documented at
the interface and validated against the bound that fits their own units: ecological sigmas must be
Q fractions (tightened from "non-negative"), brain sigmas must not exceed the weight clamp span.

## 3. `mutation.brain.weightLargeSigmaQ` had to be added

docs/04 §18 and docs/08 §17 give the brain block a large-mutation _probability_ and no large
_sigma_, while giving the ecological block both. The gap has to be closed somehow, and the three
options were: reuse an ecological sigma (wrong units — 614 read as weight units is 0.15 weight
units, _smaller_ than the small sigma), make the large class a uniform re-roll (rejected in §1), or
add the field.

The field was added, at `1476` = 0.36 weight units. The derivation is the ratio docs/08 §17 _does_
specify for the ecological block — `largeSigmaQ / smallSigmaQ` = 614/102 ≈ 6 — applied to the brain
small sigma. Against founder skip weights of 0.10 … 1.80 that is a disruptive but survivable jump,
which is what "large mutation" should mean.

This is the only new configuration field in the milestone, and it is why `CONFIG_SCHEMA_VERSION`
moves to 5.

## 4. Energy cannot be created by a birth, and the surplus is destroyed

This is the milestone's central invariant, and it needed a decision the specification does not
make.

docs/04 §19 sets child energy to `parentMaxEnergy × offspringInvestmentFraction`. The child's own
maximum energy derives from its **birth** mass — 45% of adult radius by default — so for a
large-bodied genome with a high investment gene the endowment simply does not fit in the newborn.
At the extreme (`offspringInvestment` and `adultSize` both maximal) the investment is several times
what the child can hold.

Three treatments were available:

1. **charge the parent in full, clamp the child, destroy the difference** — chosen;
2. charge the parent only the usable part;
3. let the child exceed its own maximum.

(3) breaks the invariant every other code path maintains: feeding clamps to `maxEnergy`, and an
organism above its own maximum would have a store no rule can produce. (2) looks kinder and is
worse: above the saturation point the investment gene would cost nothing and gain nothing, and a
free gene drifts to its maximum — the exact failure docs/04 §6's audit question ("why would
evolution ever select a lower value?") and docs/07 §13's trade-off list exist to prevent.

So the parent pays the full investment, the child receives `min(investment, childMaxEnergy)`, and
the difference is counted in `OrganismStore.birthEnergyDiscarded`. Energy is destroyed, never
created — the conservative direction — and over-investment carries a real cost that selection can
act on.

The counter is authoritative and hashed, for the same reason `totalBirths` is (docs/02 §9): it is
the conservation audit, and an audit that reset on reload would be worthless. It also makes the
invariant directly testable, which it now is at two levels — per birth, swept across the whole
investment × size grid, and over 2 500 ticks of a closed world where the population's total energy
is asserted non-increasing on every single tick.

## 5. Two passes, so a newborn cannot be a parent

`resolveReproduction` collects every eligible parent in ascending slot order, then performs the
births in that order.

The split is not stylistic. Deaths are finalized in phase 13, which is _before_ reproduction, so
the free list is usually non-empty and LIFO reuse can put a child in a slot **below** its own
parent (docs/10 §14). A single ascending pass would then walk into newborns and let one lineage
reproduce twice or more in the same tick, violating docs/04 §19's "at most one offspring per
organism per tick" in a way that only shows up once organisms start dying. A regression test frees
slot 0, makes every slot request reproduction, and asserts the newborn that lands in slot 0
produces nothing.

Collecting first also fixes the cap-rejection order, which docs/10 §15 requires to be ascending
parent slot, accepted as a bias and diagnosed rather than hidden behind a shuffle.

## 6. Placement rotates rather than redraws

docs/08 §16 asks for eight deterministic angle candidates before falling back to the parent's
position. The implementation draws **one** heading and **one** distance, then rotates through
`spawnAngleCandidates` evenly spaced headings from the drawn one, keeping the distance.

Redrawing per attempt would also be deterministic, but the number of draws would then depend on
the terrain around the parent, so one parent's local coastline would shift the random stream of
every organism born after it in the same tick. Two draws per birth, always, is a property worth
having.

Three smaller decisions, none of which the specification makes:

- **The child faces the direction it was placed in.** It has to face somewhere, and facing away
  from the parent means it does not spend its first ticks pushing through its own parent.
- **A parent in water produces a child in water.** All candidates fail, the fallback is the
  parent's own position, and the child takes its chances. Special-casing it would be a hidden
  survival bonus.
- **`spawnAngleCandidates ≤ ANGLE_STEPS`** is now validated. Above that the rotation step
  truncates to zero and every "alternative" candidate would be the same angle — the retries would
  silently do nothing.

## 7. Calibration finding: the reference world's carrying capacity is far above the safety cap

**This is the most important thing in this ADR that is not a code decision.**

With reproduction active, the reference world (seed `0xE0A12026`, DEFAULT_CONFIG) grows past the
`limits.maxOrganisms = 8192` safety cap. Measured trajectory:

| Tick   | Population | Births | Deaths | Max generation | Plant biomass |
| ------ | ---------- | ------ | ------ | -------------- | ------------- |
| 1 000  | 256        | 256    | 0      | 0              | 63.5%         |
| 2 000  | 1 503      | 1 525  | 22     | 1              | 74.2%         |
| 5 000  | 1 700      | 4 533  | 2 833  | 4              | 87.9%         |
| 10 000 | 4 718      | 15 408 | 10 690 | 8              | 78.5%         |
| 12 000 | 6 144      | 23 314 | 17 170 | 10             | 68.5%         |

And it is not a property of one seed. `pnpm sweep --seeds 0xE0A12026,1,7,42,1000,0xC0FFEE
--ticks 10000`:

| Seed         | Final pop | Peak      | Births | Deaths | Max gen | Trait sd   | Biomass | Cap rejections |
| ------------ | --------- | --------- | ------ | ------ | ------- | ---------- | ------- | -------------- |
| `0xE0A12026` | 4 718     | 4 718     | 15 408 | 10 690 | 8       | 0.0571     | 78.5%   | 0              |
| `0x00000001` | **8 192** | **8 192** | 33 684 | 25 492 | 8       | **0.0283** | 71.2%   | **6 112 079**  |
| `0x00000007` | 7 438     | 7 438     | 30 039 | 22 601 | 10      | 0.0549     | 68.5%   | 0              |
| `0x0000002A` | 3 638     | 5 809     | 26 953 | 23 315 | 15      | 0.0519     | 50.0%   | 0              |
| `0x000003E8` | **8 192** | **8 192** | 35 173 | 26 981 | 8       | 0.0515     | 55.6%   | **5 508 757**  |
| `0x00C0FFEE` | **8 192** | **8 192** | 36 373 | 28 181 | 13      | 0.0536     | 54.2%   | **5 959 831**  |

All six survive. **Three of six are pinned at the cap by tick 10 000**, and the two uncapped
non-reference seeds are on their way. Trait sd is the per-gene standard deviation as a fraction of a
gene range; founders start at exactly 0.0000, so every value in that column is variation mutation
produced.

The seed-1 row is the concrete form of docs/01 §11's warning that the cap biases evolution: its
trait spread is **half** that of the uncapped seeds. When only the lowest-slot eligible parents can
have children, the survivors are being filtered by storage order rather than by ecology, and
diversity collapses accordingly. That is why the counter exists and why the UI has to surface it.

docs/01 §11 requires the cap to raise a warning because it biases evolution, and docs/01 §12 makes
"population does not normally slam into engine cap" an MVP release gate. This configuration reaches
it on half the seeds tried.

It is a calibration fact, not a defect in reproduction. The mechanism is working as specified: a
mature organism needs 40% of its maximum energy to afford a child plus its reserve, mean energy sits
near 14% of maximum, and the observed birth rate is roughly one child per organism per 3 000 ticks
— far below what the 40-tick cooldown permits, so food is the limiter. The world is simply very
productive: 168.8M total plant capacity regrowing at ~1.2% per environment update supports an
equilibrium population several times the 8 192 ceiling, against a docs/07 §7 design target of
5 000.

**It was deliberately not tuned here.** docs/08 §24 requires the defaults to be implemented
faithfully first and tuned afterwards through named experiments; docs/07 §14 requires 10–30 seeds
before any tuning conclusion; and the brief for this milestone says not to calibrate aggressively
for one seed. Lowering plant productivity, raising metabolic cost or raising the cap are all
plausible and all have wide effects. That work is task L07 (10+ seed calibration) in Milestone 12,
and `pnpm sweep` (§9) is the harness it needs.

What Milestone 4 does deliver is that the cap behaves correctly when reached: the birth is refused
deterministically, `capRejectedBirths` counts it, the parent keeps its energy and its cooldown so
it may try again next tick, and **no randomness is consumed** — the capacity is checked before any
draw, so a full world cannot shift the PRNG stream of the organisms after it. Five tests cover
this, including that rejection follows ascending parent slot and that births resume the moment a
slot is freed.

## 8. New authoritative state

| Field                                     | Why it is authoritative                                                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reproductionCooldown` (per slot, Uint16) | `reproduction.reproductionCooldownTicks` is an authoritative config field. A cooldown that reset on reload would let a player double a lineage's birth rate by saving and loading. |
| `capRejectedBirths`                       | docs/03 §2 requires diagnostics for the cap. This is what makes "evolution is being distorted by the ceiling" visible instead of invisible.                                        |
| `birthEnergyDiscarded`                    | The §4 conservation audit.                                                                                                                                                         |

All three are hashed and serialized. `reproductionCooldown` is not in the docs/03 §6 array list,
for the same reason `developmentQ`, `posFracX/Y` and `waterTicks` are not (ADR 0004 §4): the list
predates the rules that need them.

The cooldown is decremented in the physiology phase (12), which already runs exactly once per
living organism per tick, and which runs _before_ reproduction (14) — so a cooldown of N spaces
births exactly N ticks apart. A test pins the resume path for all three fields.

## 9. Test-suite restructuring, and why it was necessary

Milestone 4 multiplied the cost of every long test. Before it, the reference cohort died out at
tick 6 100 and the remaining 94% of a 100 000-tick run was an empty world; a 10 000-tick run cost
~9 s. Now the population persists and a 10 000-tick run costs ~150 s.

Three changes, none of which removes an assertion:

- **`world/environmentSoak.test.ts` now runs a lifeless world** (`initialOrganisms = 0`). Its
  assertions — vegetation rising toward carrying capacity and saturating — describe the _plant
  model_, and were only ever true because grazing was negligible. Isolating them keeps them
  meaningful and makes the run nearly free. `validateConfig` was loosened to accept zero founders;
  a lifeless control world is a legitimate configuration, and nothing in the engine special-cases
  it.
- **`soak.test.ts` is the new 100 000-tick evolutionary soak** (task E07), on a 96×96 world with
  64 founders. DEFAULT_CONFIG's geometry would spend the run pinned at ~8 000 organisms and cost
  over an hour. The soak world is a better subject anyway: it boom-crashes repeatedly (population
  swinging between ~100 and ~2 800), which recycles slots far harder than a capped population, and
  it reaches generation 63 by tick 100 000 against ~8 on the reference world at tick 10 000. A
  64×64 variant was measured first and rejected because it goes extinct around tick 25 000, after
  which a soak silently stops testing anything. Every environment invariant from the Milestone 2
  soak is carried over and checked here too, alongside the organism, identity, bookkeeping and
  lineage invariants of docs/07 §4, swept every 997 ticks.
- **The global Vitest timeout rose from 60 s to 300 s**, and long-run engines are shared within a
  file rather than re-created per test. The Milestone 3 resume test now restores the shared run's own
  mid-run snapshot instead of stepping a second engine to the same tick, which are the same state by
  definition.

Measured cost of the whole suite after this: **938 s wall / 1 803 s of test time** across 4 cores,
488 tests. That is the honest price of a determinism-first project whose world no longer empties, and
it is dominated by four items — the 100 000-tick evolutionary soak, the mandated 10 000-tick golden
fixture, and the two 10 000-tick acceptance runs. It should be revisited if `pnpm verify` becomes a
per-commit gate; the levers are running the soak on a schedule rather than per commit, or Milestone
12's performance work.

## 10. `pnpm sweep` (task E08)

`scripts/sweep.ts` runs a config variant across many seeds and reports final and peak population,
births, deaths, maximum and mean generation, trait variance, biomass fraction, cap rejections, the
final hash and wall time — as a table, CSV or JSON. Variants come from `--set path=value` or from a
JSON experiment file, and an override naming a field that does not exist is a hard error rather
than a silent addition (an unknown config key would change the world hash without changing a rule).

Analytics live in `scripts/populationStats.ts`, deliberately outside `packages/engine`: docs/05 §21
forbids analytics from ever feeding back into selection, and keeping trait variance out of the
engine makes that structural rather than a promise. It is also why floating point is fine there.

The harness prints a reminder when given fewer than 10 seeds, because docs/07 §14's rule — "do not
tune from one lucky seed" — is the entire point of the tool.

## 11. Versioning

| Constant                  | Change            | Reason                                                                                                                                              |
| ------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENGINE_VERSION`          | 0.3.1 → **0.4.0** | Phase 14 runs, three counters and a per-slot cooldown joined the hash stream, and the reference world's trajectory is different from tick 1 onward. |
| `CONFIG_SCHEMA_VERSION`   | 4 → **5**         | New `mutation.brain.weightLargeSigmaQ` (§3).                                                                                                        |
| `SNAPSHOT_SCHEMA_VERSION` | 4 → **5**         | Payload gained `reproductionCooldown`, `capRejectedBirths` and `birthEnergyDiscarded`; it also embeds a config whose shape changed.                 |
| `PROTOCOL_VERSION`        | unchanged (1)     | No wire shape changed.                                                                                                                              |

Every golden hash was regenerated, and the frozen inventory of hashed config fields grew from 175
to 176 entries. The tick-1000 fixture hash happens to be unchanged from 0.3.1 — a coincidence of
the stream layout at a tick where nothing has been born and no counter is non-zero, not evidence
that the stream is the same.

## 12. Explicitly not done

- **No sexual reproduction, mate choice, crossover or dominance.** Asexual only, per the brief and
  CLAUDE.md's scope exclusions.
- **No species analysis.** A child inherits its parent's `speciesId` and stays there; splitting is
  Milestone 8. Phases 15–18 of the tick order remain unimplemented.
- **No carcasses, meat or predation.** Milestone 5. `attackCooldown` and `kills` still exist and
  stay zero.
- **No `PopulationCapReached` timeline event.** docs/05 §13 lists it, but the `EventStore` it would
  be written to is Milestone 8. Task E06's deterministic rejection and its diagnostics counter are
  delivered; the event that surfaces them to the player is not, and E06 is therefore recorded as
  partial in TASKS.md.
- **No calibration.** See §7. The defaults are implemented faithfully and the finding is reported.
- **No performance work.** Measured 4.6 µs per organism per tick, consistent with ADR 0004 §8's
  5.8 µs at 5 000 packed organisms, so the docs/07 §8 budget still holds and there is no new
  measured hotspot. Reproduction itself is not measurable against sensing and inference.
