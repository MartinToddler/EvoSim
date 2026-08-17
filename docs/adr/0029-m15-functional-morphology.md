# ADR 0029 — M15: functional morphology

Status: accepted · Date: 2026-08-17 · Engine 0.9.0 → **0.10.0** · Protocol 10 → **11** ·
Snapshot schema 9 → **10** · Config schema 8 → **9** · Render snapshot layout **2** (unchanged)

M14 gave organisms a body that is inherited, evolvable and drawn from the genome. It had no
consequence: two lineages could look nothing alike and be, in every measurable respect,
identical animals. M15 makes the body physical.

## 1. The chain, and where it lives

```text
MorphologyGenotype     27 Uint16 genes                        (M14)
        ↓              deriveMorphology
MorphologyPhenotype    a developed body: proportions, counts  (M14)
        ↓              derivePhysical            ← this milestone
PhysicalPhenotype      17 Q multipliers                       (M15)
        ↓              derivePhenotype
the numbers the tick reads   speed, armor, vision, upkeep, mass, …
        ↓              the ordinary phases
survival and reproduction
        ↓
selection
```

`packages/engine/src/morphology/physicalPhenotype.ts` is the **only** place a developed body
becomes physics, and nothing downstream of it reads a morphological gene. That is the whole
point of centralizing it: the previous milestone's ADR argued that a second copy of the
developmental rules in the renderer would eventually disagree with the first, and a second
interpretation of a body inside the engine is the same defect one layer down.

The physical phenotype is folded into `PhenotypeStore` rather than parked beside it. The
genetic mapping for a quantity and its morphological multiplier are two halves of one number;
storing them apart would leave every consumer free to read one and forget the other, which is
exactly how a picture and a simulation come apart. There is one effective maximum speed, one
effective armor value and one effective vision range, and they live where they always did.

## 2. Everything is relative to the founder body

Every factor is a Q multiplier that is **exactly 1.0 for the founder morphology**, and a test
asserts all seventeen. Three things follow.

The calibrated MVP ecology is preserved by construction. Milestones 0–13 measured a world whose
organisms all wear the founder body; if M15 had centred its physics on, say, the midpoint of
each configured range, every founder would have started life with a silently different mass,
upkeep and speed, and the carrying-capacity calibration of ADR 0025 would have been quietly
invalidated. Tick 0 of the golden fixture moves only through the config digest.

A coefficient reads as a sentence. `speedArmorGainQ: 1229` means "a fully plated body loses 30%
of its top speed relative to an unplated one", not "armor contributes 0.3 of something".

The neutral point is **derived, not written down**. `createMorphologyReference` builds the
founder genome with the shipped `createFounderMorphGenes` and develops it with the shipped
`deriveMorphology`, so a later milestone that reshapes the founder cannot leave the physics
centred on a body nothing grows. A test changes the morphological ranges out from under the
founder and checks that all seventeen factors are still exactly 1.0.

## 3. What each locus does, and what it costs

| Direction            | Buys                             | Pays with                                      |
| -------------------- | -------------------------------- | ---------------------------------------------- |
| bulk (any structure) | reserves, bite size, carrion     | basal, movement, growth, attack fee, offspring |
| girth                | energy storage, bulk             | drag, water performance                        |
| slenderness          | water performance                | thermal tolerance                              |
| limb area            | thrust, turning, paddling, accel | bulk, upkeep, movement cost, construction      |
| limb rest angle      | thrust **or** turning            | the other one                                  |
| segments             | turning                          | bulk                                           |
| plating              | armor value                      | mass, speed, upkeep, construction, offspring   |
| mouth                | attack, bite size                | jaw upkeep, turning, bulk                      |
| head                 | attack                           | bulk, fore/aft span, so turning                |
| tail                 | thrust, water performance        | bulk, fore/aft span, so turning                |
| sensors              | vision range and arc             | vision upkeep, which is range² × arc           |
| sensor placement     | range **or** arc                 | the other one                                  |

Two rows are pure allocation with no dominant setting. The appendage rest angle splits a fixed
limb area between forward thrust and lateral control; sensor placement trades vision range
against vision arc. Neither locus changes mass or upkeep at all — a test asserts that — so a
body cannot buy both halves of either.

### 3a. Three of these rows were defects that the trade-off audit caught

Writing the table down is what found the first two; the third only showed up in the selection
experiments. All three are recorded because the next milestone
will be tempted to make the same mistakes.

**The mouth was free.** Mouth size drove attack power and bite size and cost nothing: the head
area that feeds body bulk is set by `headProportion`, not by the mouth filling it. A locus with
two benefits and no cost fixates immediately and stops carrying information. The mouth now
contributes to bulk as **dense** tissue (the jaw apparatus is weighted at `plateDensityQ`
alongside plating), carries a `basalMouthGainQ` upkeep for the muscle it maintains, and costs
turning through `turnMouthGainQ` because it is mass carried out at the nose.

**The tail was a pure cost.** It extended the silhouette — which resists yaw — and added bulk,
and bought nothing. That is the trade-off rule's failure mode read backwards: a trait that can
only ever be a liability is driven to zero just as surely as a free one is driven to the
maximum, and either way the locus stops saying anything. A tail is a propulsive surface, so it
now contributes to top speed and to movement in water.

**Locomotion was free at the point of use.** This one only showed up in the selection
experiments, and it is the most important of the three — see §5c.

### 3b. Rotational inertia is the silhouette, not the body length

Turning was originally penalized by body length and by tail length as two separate terms. That
double-counts and misses the head. The fore/aft **silhouette span** — body plus head plus tail,
which is already computed for the sprite frame — is what resists yaw, so it is one term, and
head and tail both pay through it without either needing a coefficient of its own.

### 3c. Armor: the gene is the investment, the plating is the expression

`Gene.Armor` and the morphological plating loci are not redundant, but they were close enough
to need a decision. The resolution: the gene says how much armor tissue a lineage invests in,
and the plating loci say how much of the body actually expresses it. Effective armor is the
gene scaled by `armorFactorQ`, which is 1.0 at the founder's near-zero plating and rises to
1.59 at full coverage. A body with a large armor gene and no visible plating is therefore
exactly as protected as it was before M15 — no lineage is retroactively disarmed — while
visible plating always corresponds to real protection.

Because the _effective_ armor is what feeds `armorMaintCoeffQ` in the basal cost, plating
raises its own upkeep. The same is true of attack and the jaw.

### 3d. Mass is a ratio; everything else is a difference

Sixteen of the seventeen factors are `1 + Σ ±gain × (expression − founderExpression)` over
expressions normalized into `[0, Q]`. Mass is not: body area has an unambiguous physical scale,
so `massFactorQ` is the ratio of a body's area to the founder's, damped by `massBulkGainQ`.

The damping is what keeps the largest expressible body — about 11.5× the founder's area — at
3.6× its mass rather than 11.5×, which is the difference between morphology being consequential
and morphology dwarfing every ecological gene. It also keeps the heaviest body clear of the
`maxFactorQ` backstop: a test asserts that no sampled body reaches either clamp, because a
saturated factor is a region where extra investment is free.

Mass is where most of the trade-off lives, because mass is the busiest quantity in the engine.
Basal upkeep, movement cost, growth cost, maximum energy, bite size, the attack fee and the
carcass a body leaves all read it, so a heavier body is automatically more expensive to run,
worth more to eat and slower to build — none of which had to be added as a rule.

### 3e. Which loci are physically neutral, and why

Front taper, rear taper, tail taper, segment proportion, armor distribution, appendage front
bias, both pigment shifts, pigment contrast, pattern frequency and pattern orientation have
**no** physical effect.

Taper and proportion are shaping parameters: length and width already say how big a body is,
and giving taper a physical meaning would be inventing a mechanism the geometry does not model.
The pigment and pattern loci are deliberately left informational — they are the substrate a
later milestone builds visual signalling on, and giving a colour a survival effect now would
pre-decide what that colour means, which is exactly what ADR 0027 forbids.

## 4. The config cannot ask for physics that has no meaning

`validateConfig` computes, for every factor, the **smallest value any expressible body could
reach**: a term that adds bottoms out at `−gain × founderExpression`, a term that subtracts at
`−gain × (Q − founderExpression)`. If that minimum is not above zero the config is rejected.

The bound is exact rather than the cruder `Σ gain < Q` because the founder expressions are a
pure function of the config, so there is no reason to reject configurations that are in fact
safe — the cruder form rejected the shipped one. It costs two developed bodies at world
creation.

This is what makes `minFactorQ` a backstop rather than a working part of the physics. A clamp
that routinely engages is not a safety rail; it is a region of the genome space where extra
investment costs nothing, and selection finds those.

The first version of this validator rejected `DEFAULT_CONFIG` — the growth-cost gains summed to
exactly Q. That was the check working.

## 5. Evolutionary reachability, and what it cost to measure

CLAUDE.md requires that a system meant to evolve be shown to have an ordinary mutation +
inheritance + selection pathway, in the ordinary engine, with realized survival and
reproduction as the only fitness. `packages/engine/src/fixtures/morphologySelection.ts` builds
two controlled worlds and seeds each with standing variation in locomotor investment.

**Turf.** Every land biome carries the same thin capacity, and it grows back almost as fast as
it is eaten. Food is everywhere and a grazed cell is worth grazing again, so there is nothing to
travel for; what binds is what an organism spends existing and moving.

**Patchwork.** The same generator and the same biome classification, but only grassland and
forest carry biomass. Land is rich islands separated by ground that feeds nobody.

Both are seeded with an identical 50/50 mix of two locomotor morphs: long limbs and a long tail
against stubs. Both are ordinary points in the genome space, spawned as ordinary organisms with
identical ecological genes, identical brains and the same fraction of their own body's maximum
energy. Nothing assigns fitness, scores a body or touches a morphological gene.

### 5a. Twenty thousand ticks measures nothing

The first design ran both worlds from a single founder genome to tick 20 000 on three seeds and
produced a flat line: mean slenderness moved between 1111 and 1166 Q in _both_ worlds, and the
water and thermal factors stayed inside 1% of neutral. That is not evidence that morphology
does not evolve. It is the correct result for **13 generations** — selection moves a population
mean by `h²S` per generation, and at a 2.5% mutation sigma thirteen generations of anything is
drift.

Compressing the life history is not "speeding up the clock". Maturity 60–220 ticks instead of
400–2200 reaches generation 25 by tick 10 000 — and drove _every_ seed extinct between tick
10 000 and 20 000, because growth to the 90% development gate has to be **paid for** out of
intake: a tenth of the maturity age demands ten times the intake rate. A shortened life history
changes the rules, not the clock, and the scenario config says so.

What made the experiment tractable was seeding **standing variation** instead of waiting for
mutation to supply it. That is what a selection experiment is: selection sorts variation it is
given, and a population founded on one genome has none.

### 5b. The first morph pair had no axis where both ends could win

**Heavy versus light** — bulk, plating, jaw and limbs together against a minimal body — swept
to the light morph in every world within 4 000 to 8 000 ticks. Diagnosed rather than assumed:
the heavy morph pays several _multiplicative_ overheads (mass, upkeep, growth, offspring cost)
for benefits that are either proportional, and therefore neutral, or unusable. Plating in
particular buys armor, and armor is an insurance policy whose premium is paid every tick and
whose payout requires a predator; the shipped worlds record zero kills, so it is correctly
selected away. That is the trade-off rule working, not failing.

The experiment needs an axis where both ends can win, which is why the shipped pair differs in
locomotor investment alone.

### 5c. Locomotion was free at the point of use, and that is what the experiment found

A limbed morph then won on thin uniform turf, on fast-regrowing turf, on a slow-regrowing
patchwork and in an archipelago. Tripling limb upkeep barely moved it. The diagnosis was not
upkeep at all: `movementCost = mass × speedFraction² × coefficient` reads only mass, and limbs
are a small share of body area — so a body could grow a large propulsive apparatus and push with
it at almost no marginal cost. A trait that wins in every environment is exactly the "always
maximize" shape CLAUDE.md forbids, and no scenario design can hide it.

The fix is physical rather than cosmetic: movement cost now carries its own factor, driven by
limb area and lateral silhouette. Locomotion is billed twice, as it should be — once for
maintaining the apparatus and once for using it. `speedTailGainQ` also dropped from 0.30 to
0.10, because a tail was buying 15% of top speed on land for 2% of mass; it keeps its water
contribution, which is what a tail is actually for.

The coefficient was then bracketed by measurement rather than chosen. At `movementLimbGainQ`
0.45 the mobile morph still won everywhere; at 0.90 the turf turned against it. 0.90 is what
ships.

### 5d. The gaps have to be land, because organisms do not swim

Scenario B was originally an archipelago: raise the sea until land fragments, and let the
crossing select for limbs and tails. It measured **no advantage to mobility at all** — mobile
shares of 0.51 and 0.39 at `movementLimbGainQ` 0.90, on the wrong side of the 50/50 start.

The premise was wrong, and the engine had been saying so all along. Water is slow, expensive
and, past the grace window, damaging, and the terrain-danger sensors give avoidance something to
act on — so flooding the map does not create a swimming niche. It creates isolated populations
that **stay put**, which is the same pressure the turf applies. An organism will walk across
barren ground; it will not swim across water.

So the gaps are dry. Only grassland and forest carry biomass; desert, tundra and mountain are
barren, and the seed-bank regeneration floor is switched off so barren ground stays barren.

### 5e. What it measures

At `SELECTION_HORIZON` = 8 000 ticks on a 128² world, from an identical 50/50 start, where 0.0
is "every survivor is as sedentary as the seeded stub morph" and 1.0 "as mobile as the seeded
limbed morph":

| world     | 0xE0A12026 | 0xE0A13F15 | 0xE0A17CF3 | mean      |
| --------- | ---------- | ---------- | ---------- | --------- |
| patchwork | 0.823      | 0.846      | 0.843      | **0.837** |
| turf      | 0.447      | 0.458      | 0.522      | **0.476** |

The gate asserts the patchwork mean above 0.65, the turf mean below 0.55 and the separation
above 0.20 — margins with real headroom against the measurement, not fitted to it. Every
patchwork seed must favour mobility, because the effect is large enough to demand it; the turf's
effect is smaller and closer to the 50/50 start, so a majority of seeds is what is asserted
there. Demanding a fixed outcome on every stochastic run is the brittle shape ADR 0027 §3b
forbids.

## 6. Why every hash moved

Engine 0.10.0 is an intentional authoritative change: the developed body now decides mass,
energy storage, basal upkeep, growth cost, top speed, acceleration, turn rate, water
performance, armor, attack, bite size, vision range and arc, thermal tolerance, contact extent
movement cost and offspring construction cost.

Tick 0 moves through the config digest alone — the new `organism.physicalMorphology` block —
because every founder wears the founder body and is therefore exactly neutral in all sixteen
factors. The trajectory diverges from the first birth, when a mutated body first weighs, moves,
eats and costs something different from its parent's.

No PRNG draw was added or removed, so the mutation golden is unchanged.

Regenerated: the six golden fixture checkpoints and both 100 000-tick soak hashes.

## 7. Cost

Per organism: sixteen Uint16 factor rows, derived once at spawn and once per live slot on
restore, and never touched inside a tick. No per-tick allocation, no new loop and no new
spatial query; every consumer reads one extra array element where it already read a phenotype
row. `createMorphologyReference` develops two synthetic bodies per world creation and per
config validation.

The one place a bound had to be re-checked is contact extent. Soft separation, combat reach and
mouth range now scale with the drawn silhouette, and the movement phase's 3×3 neighbourhood
search assumes a body is small against a 32 LU spatial cell. `collisionSilhouetteGainQ` bounds
the factor at 1.17× against a maximum body radius of 4.5 LU, so the assumption holds with a
wide margin.
