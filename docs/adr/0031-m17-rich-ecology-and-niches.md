# ADR 0031 — M17: rich ecology and niches

Status: accepted · Date: 2026-08-17 · Engine 0.11.0 → **0.12.0** ·
Snapshot schema 11 → **12** · Config schema 10 → **11** · Protocol 12 → **13**

M14 made the body inherited, M15 made it physical, M16 made the controller's shape inherited.
All three evolved against a world with exactly one thing to eat. A single plant field admits a
single plant strategy — eat more of it — so there was nothing for a body or a brain to
specialize _into_, and every place offered the same living in a different quantity.

M17 splits the plant field into five channels and leaves meat where it was.

## 1. Five channels, and why these five

```text
  Foliage    common, cheap, fast regrowth      — the Milestone 0-16 field
  Browse     dense and tough                   — costs bite force
  Fruit      concentrated, slow to return      — costs travel
  Roots      persistent, hidden                — costs excavation
  Defended   rich, and it fights back          — costs resistance, or health
```

Each exists to make a **different** thing expensive. A channel whose cost could be paid from the
same budget as another's would be two names for one niche, so the four costs are drawn from four
places: mouth morphology (M15), movement, limb morphology (M15), and a metabolic gene. Being good
at one does not come with being good at the next.

Foliage is the Milestone 0–16 field, number for number — capacity table, growth rates, seed bank,
energy per unit. That table was tuned through the named twelve-seed experiments in docs/08 §24,
and copying it rather than reconsidering it is what lets the ecology those milestones calibrated
survive the split intact. The other four are additions on top, not a redistribution of it.

### 1a. Where a channel grows is the whole mechanism

Capacity is `base × fertility-mix × moisture × temperature × elevation`, with every factor read
from the **channel's own** profile. The same cell can be excellent foliage ground and hopeless
for roots. Nothing decides that a place is a niche; it simply happens that five suitability
curves peak in different parts of the world.

`fertilityWeightQ` is the lever that matters most. It mixes the cell's fertility toward 1, so a
channel with weight 0 ignores fertility entirely — which is what lets roots and defended growth
hold ground nothing else will grow on. A channel that cared about fertility as much as foliage
does would simply be foliage with a different name.

### 1b. "Intermittent" without a clock

Fruit is specified as intermittent. It gets there through a regrowth rate two orders of magnitude
below foliage's against a small capacity: a stripped patch stays stripped for thousands of ticks,
so the living is made by finding the next one rather than waiting at this one. Roots invert the
same dial — a high regeneration floor and a slow rate make them the channel that is always there
in small amounts, which is what "persistent" has to mean mechanically.

A clock would have been easier and wrong. A time-varying environment is M18's milestone, and
pre-empting it here would have made M18's own acceptance criteria untestable against a baseline
that already moved.

## 2. No role classes, and what that costs to mean literally

There is no `Grazer`, `Browser`, `Frugivore` or `Scavenger` type, enum, field or branch. Every
organism has a processing efficiency for every channel, always above zero, and every organism can
eat every channel — badly, if it is badly matched.

That last clause is not a courtesy. A gate of the form "you cannot process this" creates a
fitness valley in front of every intermediate on the way to using the channel, which is exactly
the defect ADR 0025 removed from carcass feeding after twelve calibration seeds ate almost no
meat in 10 000 ticks. Five such gates would have been five times the defect, so processing is a
continuous multiplier with a floor and physical access is a multiplier too — never a boolean.

The feeding phase ranks the six channels by expected obtainable gain and takes the best, ties
going to the lowest channel index. It reads the genome and the cell. It never reads what an
organism "is", because there is nothing to read.

## 3. The trade-off is priced, not constrained

Six independent processing loci could all evolve to maximum. What stops that is a bill, not a
rule: digestive upkeep charges the **sum** of the six loci above the founder's total, so a body
that is excellent at everything carries the most gut and pays for it every tick.

A normalized allocation — six loci summing to a constant — was the obvious alternative and is
worse. It makes specialization an identity enforced by the representation, which is a rule about
what evolution is permitted to express. A price says what breadth costs and lets the environment
decide whether it is worth paying. Whether a generalist is viable is an answer the world should
give, not one the genome layout should assert.

Measured against the founder and floored at zero, as M15's offspring cost and M16's neural upkeep
both had to be (ADR 0029 §3f, ADR 0030 §3a): the founder pays nothing, so the calibrated ecology
is not moved by the mechanism merely existing, and a lineage that trims below the founder earns
no rebate — a cost that can go negative is an energy source.

Toxin resistance is billed separately and squared, like armor. Without a bill it fixates
immediately and defended growth stops being a trade at all.

## 4. The defect that made the milestone fail its own criterion

The first energy-per-unit table ran 30 … 96 across the channels, on the reasoning that a channel
that is harder to reach should be worth more per unit.

Run on the ordinary engine, the founder spent its first hundred ticks eating **91% defended
growth** — the one channel that damages it, that it has no resistance to, and that it is bad at
processing.

The arithmetic is unforgiving. Expected gain is `energyPerUnit × efficiency`; the founder's
efficiencies span 0.36 … 0.84, a factor of 2.3, and the energies spanned a factor of 3.2. Raw
richness beat every genetic difference available, so the richest channel was optimal for **every
genome** — a universal strategy wearing five names, which is precisely what docs/11 §M17's
acceptance criterion forbids.

The spread is now compressed inside the efficiency spread (30 … 48). The founder gets 25.2 per
unit from foliage against 15.8 from defended and 17.3 from fruit, and a specialist flips that.
What a channel is worth is a fact about the eater again.

Worth recording plainly: no unit test could have caught this. Every part worked exactly as
specified; the specification produced a degenerate ecology. It took running the engine and
looking at what the population actually ate.

## 5. Four more defects, and the pattern behind them

**Plant demand was written out of bounds.** The claim loop keys demand by
`resource * cellCount + cell`, so that four organisms grazing a cell's foliage compete with each
other and not with the one digging its roots. `plantDemandPerCell` and `plantClaimHead` were
still one cell-plane long, so every write past the first channel landed outside the typed array
and was silently discarded. The founder ate nothing at all.

**`dietQ` had no writer.** Removing the `diet` gene left five consumers reading a phenotype field
nothing filled — the speciation trait vector, the carnivore-lineage badge, organism colouring and
the inspector — and every one of them would have seen a permanently diet-neutral population
without failing a test.

### 5a. Roots were a faucet, not a persistent channel

`seedBankRegenUnits: 12` against a threshold of 260 delivers 6000 free units per cell per 10 000
ticks — three times foliage's and twelve times fruit's — in **every cell of every world**,
regardless of capacity, fertility, moisture or the world's resource mix. Roots won a world built
to favour fruit.

Persistence is the floor now, not the rate. The rate matches foliage's; what still makes roots
persistent is a threshold far above every other channel's, so a grazed root cell holds a real
standing stock where a grazed fruit patch holds nothing. Fruit needed the same correction in the
other direction: at growth rate 3 a grazed patch took longer to return than any run lasts, which
made it a one-time treasure rather than something a lineage could live on.

### 5b. Defended growth was free, and then it was lethal

Combat applies its damage to `healthQ` inside the combat phase; `damageThisTick` in the
physiology phase is a **report** that becomes `lastDamageQ`. The toxin term was added to that
report and nothing subtracted it from health — so defended growth cost nothing and toxin
resistance was a gene with a metabolic bill and no upside. The trade-off rule broken in both
directions at once, and it invalidated a niche-world result: the toxin-rich world had been
measuring "the richest channel with no downside".

Damage now lands where it is computed, exactly as combat does it, with its own `DeathCause.Toxin`
— folding it into starvation or combat would make the timeline report a famine or a predation
that never happened.

The correction then overshot. `damageQ = allocated × toxicityQ` and health runs `0 … Q`, so
`toxicityQ: 246` made seventeen units fatal and a single bite of a 64-unit maximum killed
outright. Sized against the bite instead, 12 per unit costs a full bite about 19% of health.

### 5c. The pattern

Three of these four made a channel behave as though it had no cost, and every one of them came
from **a number whose units were asserted in a comment rather than derived from the mechanism it
feeds**. `toxicityQ: 246, // 0.06 health per unit` was not 0.06 of anything. `seedBankRegenUnits:
12, // the persistence, in one number` encoded a qualitative property as an unbounded income
stream. The energy table in §4 assumed a value scale the efficiency range could answer, and never
checked that it could.

None of them was reachable by a unit test, because each part did exactly what its own test said.
What caught them was arithmetic against the mechanism — what does this cost as a fraction of the
thing it is spent from — and running the engine to see what the population actually ate. Both are
cheap. Neither happens by itself.

## 6. Sensors report, they do not rank

Five local densities and five gradient pairs, one per channel, each normalized against that
channel's own local capacity so an organism comparing channels compares like with like.

There is no "best food here" input, and the omission is the point. A ranked input would compute
the engine's opinion of an organism's diet and feed it back as perception — ADR 0027's forbidden
direction of causation, arriving through a sensor instead of a branch. The network does the
ranking, or nothing does.

The cost is twelve more inputs: `BRAIN_INPUT_COUNT` 20 → 32, the weight block 400 → 604 before
M16's blocks and 780 after. Bounded, compile-time, and the price of a world whose channels can be
told apart by something that has to act.

## 7. Why every hash moved

Engine 0.12.0 is an intentional authoritative change on five counts:

- the environment carries five biomass and five capacity planes instead of one;
- the ecological genome went from 16 loci to 22 (`diet` out, six `Process` loci and
  `ToxinResistance` in);
- the brain layout grew to 32 inputs, so every genome is longer again;
- feeding ranks six channels where it ranked two;
- digestive and toxin-resistance upkeep join the basal cost.

Tick 0 moves through the config digest and the wider genome; the trajectory diverges immediately,
because the founders are standing on ground that now holds five resources.
