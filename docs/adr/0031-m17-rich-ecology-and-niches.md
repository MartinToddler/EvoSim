# ADR 0031 — M17: rich ecology and niches

Status: accepted · Date: 2026-08-17 · Engine 0.11.0 → **0.12.0** → **0.12.1** ·
Snapshot schema 11 → **12** → **13** · Config schema 10 → **11** → **12** · Protocol 12 → **13**

The second set of numbers is the corrective pass in §5e and §5f, which removed
`ResourceProfile.minRegenThreshold` and fixed the release-gate failure M17 shipped with.

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

Foliage keeps the Milestone 0–16 field's _shape_ — growth rates, seed bank, energy per unit,
climate curves — at a reduced scale. The five channels **partition** the world's productivity;
they do not stack on it.

That second sentence is a correction, and the original claim is worth stating so the error is
legible. This ADR first said foliage was unchanged "number for number", reasoning that preserving
it preserved the ecology docs/08 §24 calibrated, and that the other four channels were "additions
on top". Measured over three seeds, total plant capacity came out **3.5–4.4× the old foliage-only
figure**, foliage fell to 23–28% of the world it used to be all of, and the 100 000-tick soak
finished pinned at 8192 organisms — exactly `limits.maxOrganisms`, against 572 for M16. docs/01
§12 makes the cap setting carrying capacity a release-gate failure.

"Unchanged" describes a number in isolation. An ecology is a sum, and preserving one term while
adding four more multiplies it. §5e records what the recalibration cost and why the arithmetic
was worse than a simple division.

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
so the living is made by finding the next one rather than waiting at this one. Roots are the
channel that is always there in small amounts, and that comes from the capacity side rather than
the growth side — a near-zero fertility weight and a growth rate that barely varies by biome
(6, 5, 5, 5, 3 against foliage's 49, 37, 12, 12, 6) mean roots hold ground nothing else will grow
on, which is what "persistent" has to mean mechanically.

Roots originally got that property from a high seed-bank regeneration floor instead, and §5e is
the record of what that cost: a flat floor is a food source, not a character trait.

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

## 5d. What the five worlds selected

The acceptance criterion is that **no single resource strategy is structurally universal**.
Five worlds, three seeds each, 10 000 ticks, founders dealt round-robin across the six channels
as specialists and otherwise identical. What is measured is each organism's argmax processing
locus — a derived observational label the engine never reads.

Measured on engine 0.12.1, with the seed-bank floor closed (§5e) and the worlds rebuilt to hold
total capacity constant (§5f). Population at the horizon in brackets, because a world that is
dying labels nothing:

| world        | 0xE0A12026      | 0xE0A13F15      | 0xE0A17CF3     |
| ------------ | --------------- | --------------- | -------------- |
| grass-rich   | foliage (868)   | foliage (1751)  | foliage (733)  |
| fruit-patchy | foliage (693)   | foliage (1169)  | foliage (344)  |
| toxin-rich   | defended (1975) | defended (1745) | defended (936) |
| root-rich    | roots (876)     | roots (879)     | roots (901)    |
| carrion-rich | foliage (447)   | defended (222)  | foliage (155)  |

Three distinct winners; no channel wins everywhere; foliage takes 8 of 15, defended 4, roots 3.
Four of the five worlds are unanimous across their seeds, so the outcome is a property of the
world rather than of the seed. The criterion holds, and it now holds as a test —
`nicheSelection.test.ts` — rather than as a table an ad-hoc script produced once.

The earlier version of this table, taken before either fix, read foliage 4 of 15 and defended 8.
The reversal is the seed bank's doing. A flat per-cell subsidy is worth most to whatever has the
highest `energyPerUnit`, because the subsidy arrives in units and is converted at the channel's
own rate, and defended growth is the richest channel per unit. Remove the subsidy and channels
compete on production instead, which is where foliage's regrowth rate of 49 against defended's 10
tells. What looked like "defended is the fallback for anything bad at plants" was substantially an
artifact of the defect.

Two results are recorded as they are rather than tuned into a prettier shape.

**Fruit never wins any world, including its own** — and it is no longer capacity that explains it.
In the rebuilt fruit-patchy world fruit is the _largest_ channel by capacity, at 34.1% against
foliage's 32.2%, and foliage still wins all three seeds. Capacity is standing stock; what feeds a
population is production, and fruit's growth rate of 8 against foliage's 49 means the boosted
channel supplies a fraction of the flow despite holding more of the biomass. Fruit is genuinely
hard to live on, which is what "concentrated, slow to return" was specified to mean. Calling the
world fruit-patchy still describes its construction rather than its outcome.

**Carrion-rich feeds nobody on carrion.** Meat is 0.09%, 0.59% and 0.06% of intake across its
three seeds. Making the world poorer does not raise that, it lowers it — scarce plants mean fewer
and thinner bodies, bodies being made of plants — and at the 22% this fixture originally used, the
world went extinct on its first seed. So it is the lean world rather than the carrion world, and
it earns its place in the set by being uniformly poor. Carnivory as a selectable strategy is
demonstrated where it can be demonstrated honestly, in `predationSimulation.test.ts`.

The shipped world's mortality moved with it, and the same explanation covers both. Under 0.12.0,
tick 10 000 of the golden fixture recorded **3164 toxin deaths against 1538 starvation** —
defended growth was the leading cause of death in the shipped world, and §5d's earlier text
treated that as a fact about the ecology. Under 0.12.1 it is **886 toxin against 896 starvation**,
with population 650 rather than 1468. Poisoning is now one hazard among others rather than the
dominant one. The seed bank had been paying organisms to eat the poisonous channel.

## 5e. The seed bank was the food supply

M17's first 100 000-tick soak finished at **exactly 8192 organisms** — `limits.maxOrganisms`, to
the individual. M16's finished at 572. docs/01 §12 requires that "population does not normally
slam into engine cap", and §11 says why it is not cosmetic: a hard cap refuses births, and a
birth refused for being the 8193rd is a selection filter with no ecology behind it.

The obvious suspect was capacity. Five channels had been added on top of a foliage field that was
already calibrated, and measurement confirmed the world was carrying 3.5–4.4x the standing plant
capacity it used to. Rebalancing the five channels to **partition** that capacity rather than
stack on it (§5f) was clearly right on its own terms, so it was done — and the soak still ended
at 8192.

So did the next three attempts. Capacity scaled to 0.55, 0.40 and 0.30 of the recalibrated
figures all reached the cap; the last was confirmed at exactly 8192 at tick 100 000. Fitting the
four points gives `population ∝ capacity^0.6`, and extrapolating that curve says the world would
have to be cut to roughly **7% of its capacity** to come in under the cap — which would leave
nothing worth partitioning and no niches to speak of. A lever that weak is not a calibration
problem. It means capacity was not what the population was living on.

It was living on the seed bank. `growPlants` carried a per-channel `minRegenThreshold` and added
a flat `seedBankRegenUnits` to any cell below it. That term is independent of capacity, of growth
rate, and of how hard the cell is being grazed, so a cell held just under the threshold is a
permanent food source that no capacity tuning can turn down. Accounting one environment step of
the shipped world at tick 40 000, with 2841 organisms on it:

| channel  | cells below threshold | logistic energy | seed-bank energy | seed share |
| -------- | --------------------- | --------------- | ---------------- | ---------- |
| foliage  | 2630 of 11 183        | 120 120         | 315 600          | 72.4%      |
| browse   | 3623 of 11 033        | 15 470          | 246 364          | 94.1%      |
| fruit    | 105 of 477            | 288             | 10 080           | 97.2%      |
| roots    | 5057 of 11 478        | 46 930          | 768 664          | 94.2%      |
| defended | 1866 of 8131          | 46 112          | 246 312          | 84.2%      |
| **all**  |                       | **228 920**     | **1 587 020**    | **87.4%**  |

**87.4% of the world's plant production came from the flat term**, and only 12.6% from the
logistic term that capacity governs. That is the whole explanation of the K^0.6 curve: capacity
was deciding an eighth of the food. Fully grazed, the floor is worth 247 797 energy per tick
against 65 343 from the logistic term of an _ungrazed_ world — the recovery mechanism was
running at nearly four times the ecology it was meant to protect.

It was not M17 that introduced the term, but M17 that made it dominant. One channel became five,
each with its own floor, and the thresholds were set as fractions of much smaller capacities:
roots' 120 against a median realised capacity of 792 is a door that opens at 15% depletion, where
foliage's 16 against 1492 needs 99%. Roots alone supplied 42% of all production in the table
above.

The fix is to make the term mean what its own comment always said it meant — "lifts a cell off
exactly zero, where the logistic term is identically zero". It now fires **only** on an empty
cell, and `minRegenThreshold` is gone from `ResourceProfile` entirely rather than set to a small
number, because a threshold is exactly the shape of mistake that reopens this. Per-channel
`seedBankRegenUnits` stays: how vigorously a channel recolonises dead ground is a real property
of a channel, and bounded by firing once per emptying.

The same soak, unchanged in every other respect:

| tick    | before         | after   |
| ------- | -------------- | ------- |
| 20 000  | 959            | 936     |
| 40 000  | 2870           | 785     |
| 60 000  | 7504           | 859     |
| 80 000  | 12 006         | 943     |
| 100 000 | 8192 — the cap | **910** |

("Before" past tick 60 000 is from a run with the cap lifted to 40 000, because the shipped cap
censors the number that matters. Uncapped, that world was still climbing at tick 80 000.)

Standing biomass settles at 3.3M units and is flat across the last 30 000 ticks while population
oscillates between 449 and 1004 — a consumer-resource equilibrium rather than a ceiling. The peak
is 12% of the cap. Two secondary results are worth recording:

- **Capacity is a live lever again.** Re-running with the pre-partition capacities and the fix
  gives 2035 organisms at tick 10 000 against 691 — population now scales with capacity roughly
  linearly, where before it scaled as K^0.6. The partition in §5f is therefore no longer what
  keeps the population off the cap; it stands on its own argument, not on this one.
- **The magnitude of `seedBankRegenUnits` barely matters** once the threshold is gone. Flattening
  every channel to 1 unit lands at 447 organisms against 910, and with a _less_ settled biomass
  curve. The shipped values are kept.

Recorded plainly, as §4 was: three rounds of capacity tuning were spent on a lever that governed
an eighth of the food supply. What found it was accounting for where the energy actually came
from, one step at a time — not another sweep of the parameter that was already suspected.

## 5f. The niche worlds were measuring richness, not mix

`nicheSelection.ts` builds each world by scaling one channel to 160% and the rest to 25%, and its
own comment claims "any difference in outcome is attributable to the mix". That was not true: the
construction changes each world's **total** capacity as well as its distribution, and by a lot —
a world favouring fruit, which is 4.7% of the shipped world's realised capacity, came out at a
third of the richness of one favouring foliage at 46.5%.

This was invisible while the seed-bank floor supplied 87% of the food, because total capacity
barely moved the population. With the floor closed it was immediate: fruit-patchy fell to 30
organisms, carrion-rich went **extinct** on its first seed, and the outcomes those worlds
reported were noise off a dying population rather than selection.

The worlds are now built to hold total capacity fixed. For a channel with realised share `s`,
boosting it by `F` and damping every other channel by `m = (1 - F·s) / (1 - s)` leaves the total
unchanged; `F` targets a 50% share. Measured across the three niche seeds, the rebuilt worlds sit
at 99.6–100% of the base world's capacity with the favoured channel at 50.2%, 50.3% and 50.3%.

Fruit is the exception. `baseCapacityByBiome` must fit a Uint16, which caps fruit's boost at
7.28x and its share at 34.1% — enough to make it the largest channel in its own world, with
foliage at 32.2%, and not enough to make it dominant. That is a consequence of fruit's narrow
suitability window rather than something to force, and §5d's older note that "fruit never wins
any world, including its own" should be read against this constraint.

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
