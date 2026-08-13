# ADR 0008 — Milestone 5: predation, carrion and combat

Status: accepted · Date: 2026-08-13 · Engine 0.4.0 → 0.5.0 · Tasks F01–F08

Milestone 5 closes the last gap in the food web. Phases 10, 11 and 15 of the docs/03 §7 tick order
now run: every death leaves a carcass, carrion is sensed and competed for exactly like plant
biomass, organisms can damage each other, and the signed diet gene finally has two foods to choose
between.

Nothing in this milestone knows what a predator is. There is no `Predator` type, no `isCarnivore`
flag and no rule that reads one. A hunting animal is the coincidence of four general mechanisms
that every organism already had: an `attackPower` gene, an `attack` brain output, a `diet` gene that
makes meat digestible, and sensors that report where other creatures and dead bodies are. §5
reports what that produced on the reference world, including the parts that did not happen.

## 0. Which foundation this was built on

Same situation ADR 0006 §0 described, and the same resolution. The repository had four divergent
lines from the Milestone 2 commit `8aac47b`:

| Line                                   | Tip       | Content                            |
| -------------------------------------- | --------- | ---------------------------------- |
| `claude/evosim-project-setup-qrckp1`   | `734b50b` | Milestone 3 + 4 and both reviews   |
| `claude/evosim-project-setup-ps3fry`   | `73adfa7` | "Foundation gate": M0–M2 hardening |
| `claude/m2-5-review-visualizer-54i8qn` | `1083172` | Milestone 2.5 debug web view       |
| `claude/milestone-5-predation-pdire1`  | `8aac47b` | this branch, four commits behind   |

Milestone 5 depends on Milestone 3 (organisms, sensors, brains) and Milestone 4 (reproduction), so
this work fast-forwards onto `734b50b`. Nothing was lost: the predation branch had no commits of
its own, and `8aac47b` is an ancestor of `734b50b`.

Before building anything, the Milestone 4 tip was verified independently rather than trusted: a
pristine worktree at `734b50b` reproduced all six golden fixture hashes of the 10 000-tick
reference world plus the config surface tests (72 tests, 522 s). The previous milestone's claims
hold.

**The foundation-gate and 2.5 lines are still not merged**, and ADR 0006 §0's recommendation stands
unchanged: merge them before Milestone 9 (terrain edits), take the union of both hash-stream
changes, bump `ENGINE_VERSION` once and reconcile the duplicate ADR 0004 numbering. Milestone 5
does not depend on any of their six fixes — predation touches organism state, carcasses and the
combat phases, none of which read the founder region or the config surface those fixes changed.

## 1. Carcasses are a store, not objects

`ecology/CarcassStore.ts` mirrors `OrganismStore`: Structure-of-Arrays, a LIFO free stack, cleared
rows on release, ascending-slot authoritative iteration, and the whole thing hashed and serialized.
Carrion is sensed and eaten, so it is authoritative state in the fullest sense — a resumed world
that lost its carcasses would immediately behave differently from the one that was saved.

Two decisions worth recording:

- **A carcass carries the dead organism's entity ID rather than a new one.** Entity IDs are never
  reused (docs/03 §5), so this gives every carcass a stable, unique identity for tie-breaking
  without minting a second ID space to keep monotonic and serialize.
- **The free list is serialized verbatim**, for the same reason the organism one is (docs/10 §18):
  it decides which slot the next death reuses, and the reuse order decides which carcass a later
  distance tie resolves to.

`ageTicks` advances by `time.carcassDecayInterval` per decay step rather than by one per tick. The
decay phase is the only phase that visits carcasses, and adding a per-tick sweep over up to 4 096
rows to make a counter that nothing reads per-tick finer is not a trade worth making. The
resolution is documented at the field.

**No phase number was added.** The versioned list in docs/03 §7 is unchanged: creation happens inside
phase 13 (before the organism's slot is released), decay is phase 15, and the carcass spatial index is
rebuilt inside phase 2 alongside `spatialPre` — it is an index build before sensing, which is what
that phase is. One index serves both the sensing phase and the feeding phase even though they sit
either side of movement, because a carcass never moves and nothing creates or removes one between
phase 2 and phase 9. The consequence is stated where it matters: a carcass created in phase 13 first
becomes sensible and edible on the following tick, which is the same rule sensing already follows —
an organism cannot react to something that did not exist when it looked.

## 2. Meat conservation is the invariant that replaces energy conservation

Milestone 4's central invariant was that a birth cannot create energy (ADR 0006 §4). Milestone 5
cannot make the same claim about carcasses, and it is important to be precise about why rather than
to imply an identity that does not hold.

A body is worth `mass × meatPerMass` meat units plus a bounded share of the energy it still held.
With the docs/08 §15 defaults, the mass term converts a body into **more** energy than the organism
could itself hold: mass `m` costs `35m` to grow and yields up to `3m × 45 = 135m` energy as meat.
That is deliberate and it is the specification's number, not an accident of the implementation.
Carrion is an ecological energy source on the same footing as the plant field's
`plantEnergyPerBiomass` — a world's energy comes in through plants and through bodies, and the meat
rate is a tuning constant like every other.

What **is** exact, and is asserted at three levels:

```text
totalMeatCreated == totalMeatEaten + totalMeatDecayed + Σ remainingMeat
```

The energy term is separately bounded: at most `remainingEnergyToMeatMaxFractionQ` (0.25) of the
dead organism's remaining energy is recoverable by whoever eats it, even at perfect digestion. That
is the conservative direction — dying destroys energy, it never multiplies it — and a test pins it
by ablating the mass term and comparing the recoverable energy against the bound.

## 3. Constants the specification leaves open

Three fields were added, which is why `CONFIG_SCHEMA_VERSION` moves to 6. Each closes a gap where
docs/08 gives a magnitude without the scale to read it against — the same kind of gap ADR 0006 §3
closed for `weightLargeSigmaQ`.

| Field                                                 | Value | Why it had to exist                                                                                                                                                                                                   |
| ----------------------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organism.carcass.hotDecayMinTemperatureCentiC`       |     0 | docs/03 §23 requires decay "affected at least by temperature"; docs/08 §15 gives `hotDecayBonusMaxQ` but no temperature to reach it at.                                                                               |
| `organism.carcass.hotDecayFullBonusTemperatureCentiC` |  3500 | The other end of the same ramp. 0 °C … 35 °C spans the world's typical field (docs/03 §17), so rot is free at freezing and doubles at the hot end.                                                                    |
| `combat.attackSizeFactorFloorQ`                       |  2048 | docs/08 §14's `sizeFactor = 0.5 + 0.5 × sizeNorm` states one constant twice. Only the floor is configured; the span is derived as `Q - floor`, so the two halves cannot drift apart and the factor cannot exceed 1.0. |

Two other quantities the specification names but does not size are deliberately **not**
configuration, because geometry already answers them:

- **Contact range for an attack** is `attackerRadius + targetRadius` — two discs touching. A
  configured reach would be a magic number with no observable meaning.
- **Mouth range for a carcass** is the eater's own current body radius. A carcass is a point
  (docs/03 §23 gives it no radius), so "in mouth range" means the eater is standing on it. Body
  radius is already the length scale every other contact rule in the engine uses.

One engine constant was added: `MIN_CARCASS_DECAY_UNITS = 1`. An integer fraction of a small number
truncates to zero, so at the default 0.49% per step a carcass holding fewer than 205 units would
lose nothing, forever, and would hold a capped slot until something ate it. One unit is the
smallest possible non-zero decrement, which makes decay strictly monotone and guarantees
termination without adding a second rate to tune. It deliberately does **not** fire when the
configured rate is zero, so the "carrion never rots" ablation stays available; a test pins that.

## 4. Combat: what the phase split is actually protecting

docs/10 §13 and §25 are unusually specific — accumulate damage, then apply it, and never finalize a
death inside the attacker loop — and it is worth writing down what breaks otherwise. Applying
damage as it is dealt would mean the lower-slot organism of a mutual attack always wins, mutual
kills become impossible, and a target attacked by several organisms absorbs the blows in storage
order. Slot order is an internal storage detail that changes whenever something dies, so that is
not merely unfair, it is non-reproducible in spirit even while being deterministic in fact.

So phase 10 validates attackers, charges them, and files damage claims; phase 11 applies the totals.
Tests cover the mutual kill, three attackers stacking on one target, and the case where the target
was already one blow from death — both attackers still pay and both blows still count.

**Kill attribution** is the largest single contributor, ties to the lower attacker entity ID. Entity
ID rather than slot, again because slots carry the accident of who died recently. The credited
attacker may itself be dying on the same tick; its `kills` counter is then released with its slot,
which is what a per-organism lifetime counter means.

**The attack cooldown is decremented in the combat phase**, not alongside the reproduction cooldown
in the physiology phase. This is the one place where two similar counters are handled in two
different places, and it is forced: `attackCooldownTicks` has to mean "attacks are that many ticks
apart", reproduction runs _after_ physiology while combat runs _before_ it, so a shared decrement
would silently cost one tick off every attack cooldown. A test pins the exact spacing.

**An attack with no target in reach costs nothing** — no energy, no cooldown. Validation precedes
the deduction (docs/10 §13's own order), so a swing at nobody was never a swing.

`lastDamageQ` needed a small change to stay honest. Combat damage lands in phase 11 and
starvation/thermal damage in phase 12, and the field means "damage taken this tick", so the
physiology phase now seeds its accumulator from what combat applied instead of overwriting it. The
value travels through a scratch array, the same way movement's realized speed already reaches
metabolism.

## 5. What the reference world actually did — and did not do

Measured on seed `0xE0A12026` with DEFAULT_CONFIG, 10 000 ticks:

```text
tick  10000 | pop 4364 | gen 8 | births 13212 | deaths 8848 | var 777110
            | carcasses 4096 skipped 4751 | meat 5885.4k created, 0.0k eaten
            | kills 0 | mean diet -0.597
```

Before the findings, a cross-check on the size of the behavioural footprint. Deaths in the reference
world start after tick 1 000, and up to that point the trajectory is **identical** to 0.4.0: at tick
1 000 both engines report population 256, births 256, deaths 0 and trait variance 0. At tick 2 000 the
two have diverged — same 1 525 births, but 19 deaths against 22 — which is exactly what should happen
if the only new influence is carrion: the first carcass appears shortly before that, and from then on
the eat drive of anything standing near a body is different. The state _hashes_ differ from tick 0, but
that is the config digest and the (empty) carcass store joining the stream, not behaviour.

Three findings, in order of how much they matter.

### 5a. Nothing was eaten, and that is the specified behaviour

**Zero meat was consumed in 10 000 ticks.** The reason is the docs/04 §20 food-target policy,
implemented verbatim: an organism attempts a carcass only if it is in mouth range **and** its meat
efficiency is at least its plant efficiency. The founder's diet gene is −0.60, giving plant
efficiency 0.71 against meat 0.23, and mean diet after 10 000 ticks is −0.597 — mutation has barely
moved it. Not one organism in the run was ever carnivorous enough to prefer a body.

This is worth stating plainly because it looks like a broken feature and is not:

- the mechanism works — the predator/prey fixture kills, scavenges and digests through the real
  tick loop, and the controlled diet experiment shows a carnivore specialist out-reproducing a
  herbivore in a meat-rich world and losing to it in a plant-rich one;
- docs/07 §5 explicitly says a handcrafted predator fixture "does not guarantee spontaneous
  carnivory", and docs/07 §12 lists "carnivory impossible" as a calibration failure mode to
  monitor, not a bug to patch;
- the honest reading is that **carnivory is reachable but not yet reached** on this seed at this
  horizon. Whether it is reachable _in practice_ is a calibration question for L07, and it now has
  the instrumentation to be answered: `pnpm headless` reports mean diet, meat created, meat eaten
  and kills at every checkpoint.

A second-order effect deserves recording because it surprised the measurement. Carrion made
herbivores eat **more**, not less. The founder's eat output carries a +0.40 weight on
`carcassProximity` (docs/08 §20), which was pinned at −Q for all of Milestones 3 and 4 because no
carcass could exist. Now a nearby body raises the eat drive by up to 0.80 — and since a herbivore's
target is still the plant cell, carrion acts as an appetite stimulant for grass. Total deaths at tick
10 000 fell from 10 690 at 0.4.0 to 8 848 (of which 8 793 are starvation, 38 old age and 17
drowning), and the population came out lower (4 364 against 4 718) with roughly three times the trait
variance. That is a consequence of the
founder weights meeting a single `eat` action, both of which are specified, and it is exactly the
kind of thing that only shows up once a sensor stops being a constant.

### 5b. The carcass cap saturates, hard

**4 096 carcasses live and 4 751 skipped at tick 10 000.** Over half of all deaths after the cap
fills leave no body at all. The cause is arithmetic, not a defect: at the docs/08 §15 decay rate and
the reference world's ~18 °C, a typical ~960-unit carcass loses 0.74% per step down to ~137 units
(263 steps) and then one unit per step (137 steps) — about 400 decay steps, or **8 000 ticks**. A
world losing roughly one organism per tick therefore accumulates toward ~8 000 carcasses against a
`maxCarcasses` of 4 096. The measurement corroborates the derivation: of the 4 097 carcasses created
by tick 10 000, exactly one had finished decaying.

The behaviour at the cap is correct by specification — deterministic skip plus a diagnostics counter,
never a random eviction (docs/10 §14) — and `skippedAtCap` is hashed so the loss is visible rather
than silent. But it suppresses the very thing this milestone exists to enable: a lineage that
evolves toward meat would find half the potential carrion missing.

**It was deliberately not tuned**, for the reasons ADR 0006 §7 gives for the population cap:
docs/08 §24 requires the defaults to be implemented faithfully first, and docs/07 §14 requires
10–30 seeds before a tuning conclusion. The levers are `limits.maxCarcasses`, the decay rate and
the hot-decay ramp. This is input for **L07** alongside the population-cap finding, and the two are
linked: fewer deaths per tick would relieve both caps at once.

### 5c. No attacks happened

Zero kills, as designed. The founder's attack output is `−0.85 × bias`, giving 0.075 against a 0.65
threshold, and its attack gene is 0.10. Combat is unreachable without mutation moving both, which is
what makes predation an evolutionary achievement rather than a starting condition (docs/08 §20).

## 6. Testing

78 new tests across six files, plus the amended goldens and four new config-validation cases.

| File                             | Covers                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecology/CarcassStore.test.ts`   | slots, LIFO reuse, cap skip, meat conservation, hashing sensitivity, snapshot round trip and four malformed-restore rejections                                                                      |
| `ecology/carcasses.test.ts`      | creation from every death cause, meat valuation, the energy bound, cap diagnostics, temperature-driven decay, the decay floor, termination, the no-decay ablation                                   |
| `ecology/combatClaims.test.ts`   | out-of-range no-hit, threshold, energy cost, insufficient energy, cooldown spacing, armor mitigation, size and impact scaling, mutual kill, three attackers stacking, attribution and its tie-break |
| `ecology/carcassFeeding.test.ts` | the docs/04 §20 target policy in four configurations, meat energy conversion, the maximum-energy clamp, proportional sharing, the entity-ID remainder, slot release                                 |
| `brain/carcassSensors.test.ts`   | absence as −Q, proximity ramp, range and FOV limits, forward/lateral axes and heading rotation, distance-then-ID ties, and that no other sensor moves                                               |
| `predationSimulation.test.ts`    | the predator/prey fixture and mutual kill through the REAL tick loop, diet selection in a plant world and a meat world, snapshot/resume with carrion, same-seed reproducibility                     |

The acceptance fixtures deserve a note on method. They run `SimulationEngine.step()` rather than
calling phases directly, so the phase order, both spatial rebuilds and the scheduled decay cadence
are the shipped ones. The cast is handcrafted through the package-internal channel `internal.ts`
documents for engine tests, on worlds configured with `initialOrganisms: 0`.

The diet-selection experiment is the one that answers "does the trade-off actually select?". Two
cohorts differ in exactly one gene, share one brain, stand still, and live in worlds that differ
only in which food exists; mutation is switched off so a lineage's diet cannot drift and the result
can come from nothing else. Realized reproductive success — births, counted per lineage each tick —
favours the herbivore in the plant world and the carnivore in the meat world. That is fitness as
docs/05 §1 defines it, with no fitness function anywhere.

## 7. Performance

The carcass index is a second `SpatialGrid` rebuilt once per tick from the same generic
`rebuildFrom` the organism grids use, so carrion sensing visits only the grid cells the observer's
vision range overlaps — up to 7×7 cells at the maximum genetic range, one or two for the mouth-range
query — rather than scanning every carcass. Without it the sensor would be the O(N×M) shape that
4 096 carcasses × 4 364 organisms turns into the dominant cost in the engine. Both carcass queries
also return immediately when the world holds no carrion, which is the whole of a young world and all
of the unit tests.

**Reference world.** The 10 000-tick run costs 153 s of simulation against 188 s for the same run at
0.4.0, measured on the same machine — 15.3 ms/tick, inside the docs/07 §8 ideal of 25 ms and well
inside the 50 ms requirement. It got _faster_, which is a population effect rather than an
optimization: 4 364 organisms instead of 4 718, and sensing dominates the tick.

**Soak world**, which is the harsher subject and where the cost is real. Measured on the 96×96 soak
configuration, stepping in 5 000-tick blocks:

| Tick   | ms/tick | Population | Carcasses |
| ------ | ------: | ---------: | --------: |
| 5 000  |   13.29 |      2 760 |     2 796 |
| 10 000 |   23.68 |      1 718 |     4 096 |
| 15 000 |    3.49 |      1 184 |     2 255 |
| 20 000 |   14.10 |      1 101 |     4 096 |
| 25 000 |    4.20 |        576 |     3 566 |
| 40 000 |    4.26 |        576 |     3 708 |

The cost tracks population × carcass density, which is what carrion sensing costs: every organism
looks for a carcass every tick whether or not its diet could use one, and the soak world packs up to
4 096 carcasses into 2 304 spatial cells (~1.8 per cell against ~0.25 in the reference world). The
100 000-tick soak went from ~350 s to 1 817 s including the environment soak in the same run.

That is a measured regression and it is reported rather than optimized, because the numbers do not
justify optimizing yet: the peak 23.7 ms/tick is still inside the docs/07 §8 ideal, and it occurs in
a deliberately harsh test world rather than at the design target. docs/07 §10 and CLAUDE.md both say
to optimize measured hotspots only, and the lever if it ever becomes necessary is named there —
spatial queries, specifically pruning whole grid cells that cannot contain a closer candidate. The
cheap wins are already in: both carcass queries return immediately when the world holds no carrion,
the index is a shared `SpatialGrid` rather than a scan, and candidates are rejected on squared
distance before the field-of-view test is paid for.

## 8. Versioning

| Constant                  | Change            | Reason                                                                                                                            |
| ------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ENGINE_VERSION`          | 0.4.0 → **0.5.0** | Phases 10, 11 and 15 run, the carcass store joined the hash stream, and the carcass sensors changed behaviour from tick 1 onward. |
| `CONFIG_SCHEMA_VERSION`   | 5 → **6**         | Three new fields (§3).                                                                                                            |
| `SNAPSHOT_SCHEMA_VERSION` | 5 → **6**         | The payload gained the carcass store, and it embeds a config whose shape changed.                                                 |
| `PROTOCOL_VERSION`        | unchanged (1)     | No wire shape changed; the worker protocol is Milestone 6.                                                                        |

Every golden hash was regenerated: the six fixture checkpoints, the config digest
(`2d2712ccf817a700`), and both soak hashes. The mutation fixture's genes, brain digest and PRNG
state are **unchanged** — mutation was not touched, and only its version stamps moved, which the
test proves by still matching them. The frozen inventory of hashed config fields grew from 176 to
179 entries.

## 9. Explicitly not done

- **No species-level meat accounting.** docs/05 §5 lists `totalKills` and `meatEnergyConsumed` per
  species; the `SpeciesStore` they belong to is Milestone 8. The per-organism `kills` and
  `meatEnergyEaten` counters they will aggregate exist and are populated.
- **No `CarnivoreEmerged` event.** docs/05 §13 lists it and `history.carnivoreObservedMeatFractionQ`
  is already in the config, but the `EventStore` is Milestone 8 — the same reason E06's
  `PopulationCapReached` is still open.
- **No separate attack/eat targets for the brain.** One `eat` output, engine-chosen target, exactly
  as docs/04 §20 specifies. A second food action would be a brain format change (docs/04 §10).
- **No smell.** Carrion is found with the vision range and field of view, because a separate sense
  would be a new sensor input and therefore a new brain format.
- **No calibration.** See §5b and §5a. Two findings are reported and neither is patched.
- **No renderer.** Carcasses are authoritative state with positions and remaining meat, ready for
  the Milestone 6 render snapshot; nothing draws them yet.
