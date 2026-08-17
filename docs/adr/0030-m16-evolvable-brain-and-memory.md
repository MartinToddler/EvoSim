# ADR 0030 — M16: evolvable brain topology and generic memory

Status: accepted · Date: 2026-08-17 · Engine 0.10.0 → **0.11.0** ·
Snapshot schema 10 → **11** · Config schema 9 → **10** · Protocol 11 → **12**

M14 made the body inherited. M15 made it physical. The controller was still a fixed
20 → 12 → 5 network in which only the strength of each wire evolved, and it had no way to
remember anything: every tick began from the same blank state. M16 makes the network's _shape_
inherited and gives it somewhere to keep a thought.

## 1. The topology genome

Five bitmasks over a ceiling the layout already declares:

```text
  inputs        20 bits    which senses reach the network at all
  hidden        12 bits    which units participate
  recurrent     12 bits    which units see their own previous activation
  memory         4 bits    which registers are retained
  connections  576 bits    which individual weights are wired in
```

Forty-one Uint16 words — 82 bytes — per organism, whatever the network. There is no growth
anywhere: the maximum brain is a compile-time constant and a genome can only switch parts of it
off. That is what "no unbounded NEAT growth" means in practice, and it is why no organism owns a
graph object and nothing allocates per tick.

### 1a. Why masks, when a zero weight already disconnects

Two reasons, and neither is cosmetic.

A mask makes complexity **countable**, which is what lets it be charged for. "How many
connections does this brain use" has no answer when the only evidence is a number that happens
to be near zero; with a mask it is a popcount, and the metabolic cost in §3 can be a function of
it.

A mask also lets a lineage switch a connection off **without losing what it learned**. A weight
zeroed by mutation is gone; a weight masked off keeps its value and comes back with a single bit
flip. That is the difference between structural change being a cliff and being reversible, and
reversible structural change is the entire point of evolving topology. A test pins it: cut a
wire, confirm the output drops to zero, confirm the weight is still there, switch it back on and
confirm the original output returns.

## 2. Memory, and the two decisions that make it mean anything

Four registers, `memory0 … memory3`. They are numbered and never named. The engine does not know
what a lineage keeps in `memory2` and ADR 0027 forbids it from ever finding out — a register is
somewhere to put a number, and what the number means is the lineage's business.

### 2a. A gate and a value, not one weight block

Each register is written through two independent drives from the hidden layer: a **gate** that
decides whether to write at all, and a **value** that decides what. The update is a blend,
`memory += gate × (value − memory)`, so a gate near zero holds what is there and a gate near one
overwrites.

One weight block could not express this. A plain assignment can only latch, so nothing could
hold a value loosely; a running average can never latch at all, so nothing could be remembered
sharply. The capability fixtures need both — the persistent-bearing fixture latches while a cue
is present and holds afterwards — and "keep what you have" and "store this now" have to be
separable decisions for that to be expressible.

The gate is clamped to `[0, Q]`: a negative drive means "do not write", which is the resting
state a register needs in order to hold anything at all.

### 2b. Writes happen after the outputs are read

Ordering is load-bearing. A register written before the outputs would let a network react in
tick N to a value it decided to store in tick N, which is a hidden zero-delay loop wearing the
word "memory". Writing last makes every register exactly one tick old when it is read, so
remembering and recalling are always separated by a tick.

A test asserts it directly: on the tick a register is first written, the output reading that
register still sees zero; on the next tick it sees the stored value.

### 2c. Neural state is authoritative, and that is the difference from M14 and M15

`MorphologyStore` and `PhysicalPhenotypeStore` are derived caches — pure functions of the
genome, never hashed, never serialized, rebuilt on restore. `NeuralStateStore` is the opposite
in every respect, because memory is **history** rather than a function of the genome. It is
hashed with the world, written into every snapshot and restored verbatim.

That is not bookkeeping; it is what memory means. An organism halfway through an alternation, or
holding a bearing it latched two hundred ticks ago, has to still be that organism after a save
and load, after a rewind, and in every branch taken from one save. A store that was rebuilt
rather than restored would hand every organism amnesia at each rewind and make two branches of
one save diverge for no reason a player could see.

Memory does not survive death, and is not inherited. A newborn gets its parent's genome, not its
parent's thoughts, and a recycled slot is wiped — otherwise storage order would leak into
biology.

## 3. Complexity is charged for, from the first commit

Every mask bit a lineage sets buys capability: another sense, another unit, another wire,
another thing remembered. CLAUDE.md's trade-off rule is explicit that a benefit with no cost
fixates immediately and stops carrying information, and M15 learned that three separate times
over. M16 pays for complexity before the first measurement rather than after.

The charge is per-tick metabolic upkeep, added to the basal cost the physiology phase already
bills. It is the only basal term that does not scale with mass — nervous tissue is billed by
what it is, not by how big the animal carrying it is.

### 3a. Measured against the founder, and floored at zero

The founder's brain — 20 senses, no hidden layer, 100 skip wires — is what Milestones 0–13
calibrated an entire ecology around. Charging it for its own existence would move every
population number in the project for reasons unrelated to evolving topology. So the founder's
complexity is the free allowance and only the excess is billed; a test asserts the founder pays
exactly zero.

The excess is **floored at zero**. A lineage that trims below the founder pays nothing extra and
does not earn a rebate. This is precisely the shape M15's offspring-construction cost had to be
given after the twelve-seed sweep caught it creating energy (ADR 0029 §3f), and applying it
preemptively here is the cheapest lesson in this project so far: a cost that can go negative is
an energy source, and one attached to "do less" is a bug with an evolutionary strategy already
attached.

Parsimony still pays, just not through a rebate. An unused sense whose channel is masked off
stops feeding noise into the network, and an unused wire stops carrying a mutation's drift into
an output. Those are behavioural benefits, which is where the benefit of simplicity belongs.

Measured with the shipped coefficients: the founder pays 0 and the most complex expressible
brain — every unit, every register, every wire — pays 32 energy/tick, against a measured basal
cost of 10 for a newborn founder and a 30 adult mean. A maximal brain roughly doubles an adult's
upkeep: a decision, not a rounding error, and not a prohibition either. §9 is about the first
calibration, which was the third of those.

The coefficients are Q-scaled, and any non-zero excess is billed at least one whole energy per
tick. That floor is what stops a fractional scale from becoming a free one at the bottom.

## 4. Structural mutation draws a count, not a bit

The topology genome is 624 addressable bits. A per-bit classification roll — how the ecological,
morphological and weight blocks work — would cost 624 PRNG draws at every birth, more than
doubling the 443 the engine already spends, for a block where nearly every draw resolves to "no
change".

So structural mutation rolls a probability gate, then a **count**, then two draws per flip. A
birth that changes nothing costs one draw; the cost is `1 + 2 × flips` and is bounded by the
config.

The independence from network size is a determinism requirement, not an optimisation. If the
draw count depended on how complicated an organism's brain happened to be, one lineage's
structural history would shift the random stream of every organism born after it. A test runs an
empty genome and a completely full one from the same seed for 500 births and asserts the two
PRNG states stay identical.

## 5. What the acceptance fixtures prove, and what they deliberately do not

Nine hand-built networks show that the architecture can **represent** food approach, threat
avoidance, state-dependent action, temporal alternation and a persistent bearing held across
forty ticks after its cue disappears.

None of them is installed into any organism. They are not founder brains, not templates, not a
library the engine draws on, and nothing outside the test file constructs them. That distinction
is the entire exercise: a behaviour the engine _provides_ is a scripted role, while a behaviour
the engine can merely _express_ is a place evolution is allowed to go, and M16's job is to widen
the second set without adding anything to the first.

The persistent-bearing fixture is the one to read twice. It is built from `memory0` and an
ordinary creature cue, and at no point does the engine know that the number in that register is
a direction. If a lineage ever evolves something similar, nothing in the code will recognise it
as "going home" — which is exactly the property that makes it a discovery rather than a feature,
and exactly what ADR 0027 §3 requires of everything M23 will later build on.

## 6. Why every hash moved

Engine 0.11.0 is an intentional authoritative change on four counts:

- the topology genome is inherited state, so it joins `GenomeStore.hashInto`;
- authoritative neural state joins the canonical stream as its own section;
- the weight block grew from 400 to 576, so every organism's genome is longer;
- structural mutation adds draws to the PRNG stream at every birth.

Tick 0 moves through the config digest, the wider genome and the founder's topology. The
trajectory diverges from the first birth.

Regenerated: the six golden fixture checkpoints and both 100 000-tick soak hashes.

## 7. What the inspector shows

`EntityDetailsDto.brain` carries five counts, the upkeep they cost, and the current register
contents. The founder reads 20/0/0/0/100 at zero upkeep, so any organism whose numbers differ has
an evolutionary history worth looking at — which is the cheapest possible answer to "has anything
actually happened to the brains in this world".

The registers are shown **unlabelled**, as four numbers. The engine does not know what a lineage
keeps in `memory2` and the panel must not pretend otherwise; a column headed "home X" would be
ADR 0027's forbidden direction of causation arriving through the UI instead of the engine.

## 8. The defect widening the genome caused, and the guard against it

Growing the weight block from 400 to 576 left three call sites copying 400: the test harness's
silent brain, the soak world's weight scan, and — the one that mattered — the inheritance copy
in `resolveReproduction`.

That third one is worth stating precisely, because its failure mode is not the obvious one. The
child genome is assembled in a **scratch buffer reused by every birth in the phase**, so copying
only the first 400 entries did not leave the tail zeroed; it left the _previous child's_
recurrent and memory weights there and handed them to this one. Inheritance from an unrelated
organism, through a buffer that is deliberately neither hashed nor snapshotted.

It surfaced as a save/restore divergence rather than as anything about brains. Restore
reproduced the state hash exactly and then diverged as it continued, which is the signature of
authoritative state that is neither hashed nor serialized — and a scratch buffer is exactly that
by design, correctly, _provided every use overwrites all of it_. A partial write silently
promotes scratch to state.

The guard is a test that switches mutation off, reproduces two parents with distinct weight
blocks in one phase, and asserts each child's full block equals its own parent's. It fails on any
copy narrower than the genome, and it will keep failing for whatever M19 does to this same
buffer.

## 9. Reachability, and the calibration defect it caught

§5 is careful that the capability fixtures prove **representability**. CLAUDE.md's evolutionary
accessibility rule asks a different question, and asks it about memory by name: is there an
ordinary mutation + inheritance + selection pathway to memory use, on the ordinary engine, with
realized survival and reproduction as the only fitness?

The first attempt to answer it failed, and the failure was in M16 rather than in the experiment.

### 9a. Thinking was priced out of existence

Run the ordinary engine from founders for 10 000 ticks and count what the population's brains
actually became. Mean hidden units per organism: **0.002**. Structural mutation was switching
them on and selection was removing them within a generation, every time.

The arithmetic says why, and it is not subtle. A hidden unit is not a thing a lineage buys on
its own — a _usable_ one arrives wired to twenty inputs, five outputs and itself, which is
twenty-six connections. At one whole energy per connection that unit cost 31 energy/tick, and
the measured basal cost of a founder is **10/tick as a newborn and 30 as an adult mean**. One
neuron cost an adult's entire basal bill. The most complex expressible brain cost 545/tick.

§3a's original numbers were wrong in exactly the way that hid this: "a brain with all twelve
hidden units awake pays 36 energy/tick" counted the units and forgot the wires they need to do
anything. A cost per item is not a cost per capability when the items only come in bundles.

The trade-off rule asks for a credible cost, and a cost that forbids a trait outright is not
one — it is the "always minimize" failure the rule's second half warns about, arrived at from
the other direction than M15's free locomotion but every bit as much a defect. Charging for
complexity is what makes topology evolvable; overcharging for it makes topology decorative.

The coefficients are now Q-scaled. A usable hidden unit costs 1.93/tick, and the maximal brain
32/tick — roughly double an adult's upkeep, which is the "decision, not a rounding error" §3a
always meant. Any non-zero excess is billed at least one whole energy per tick, so the
fractional scale cannot become a free one at the bottom.

### 9b. The experiment's first design was confounded

Worth recording rather than quietly replacing, because the mistake is an easy one to repeat.

It compared a memory-capable brain against **the pristine founder** — and the complex group was
gone inside 1000 ticks. That is less than one generation at the founder's maturity age, so
whatever killed it, it was not selection. It was a randomly wired controller behaving worse
than a tuned reflex one, and the memory registers had nothing to do with it.

Both groups now get an **identical hidden layer with identical weights**, drawn once per pair
from a stream that never touches the engine's own. They differ in whether the four registers
exist and are wired, and in nothing else. Only in that arrangement is a difference in outcome
attributable to memory.

The added weights are drawn small — four small-mutation sigmas — rather than uniformly over the
legal range. That is faithful as well as necessary: a wire ordinary evolution has just switched
on carries whatever drift has accumulated on a weight that started at zero, not a full-scale
random value. The first draw saturated every hidden unit and left networks that had stopped
responding to their senses, which measures saturation rather than memory.

### 9c. What the two halves measure

Two claims that pull against each other, so the result is a **contrast** rather than a number:

1. complexity that costs and does not pay must be selected **against**, or the cost is
   decorative;
2. the same complexity where it can pay must **not** be priced out, or memory is unreachable in
   practice whatever the fixtures show.

The worlds are M15's, imported rather than re-invented (ADR 0029 §5): on the turf, thin food is
everywhere and grows back, so the right action is always derivable from the current senses; on
the patchwork, rich patches are separated by barren ground where the senses report nothing
useful, so carrying _anything_ across the gap is worth something.

### 9d. What it measured

Share of the living population still carrying a live memory register after 8 000 ticks, from an
identical 50/50 start, three seeds per world:

| world     | 0xE0A12026 | 0xE0A13F15 | 0xE0A17CF3 | mean      |
| --------- | ---------- | ---------- | ---------- | --------- |
| turf      | 0.133      | 0.297      | 0.266      | **0.232** |
| patchwork | 0.387      | 0.995      | 0.940      | **0.774** |

Both halves hold, and the patchwork column is the stronger result: on two of three seeds the
memory-carrying group did not merely survive its upkeep but approached fixation, and the
survivors kept a mean of 3.98 and 3.76 of their four registers rather than trimming to one. The
same population on the same seeds falls to 0.297 and 0.266 on the turf. Nothing about the two
worlds mentions brains, no fitness is assigned, and no topology bit is touched after tick 0 —
the environment decides whether memory is worth its upkeep.

The turf column is also the trade-off rule demonstrated by measurement rather than asserted: a
retained register costs energy every tick, and where it buys nothing it is removed.

### 9e. Structural exploration, separately

The seeded experiment shows selection sorting standing variation, which is what a selection
experiment can show. That mutation reaches the variation in the first place is a different
claim, measured on ordinary unseeded worlds over 10 000 ticks:

| seed       | distinct topologies | connections (min…max) | mean registers |
| ---------- | ------------------- | --------------------- | -------------- |
| 0xE0A12026 | 54                  | 99…104                | 0.000          |
| 0xE0A13F15 | 121                 | 97…105                | 0.001          |
| 0xE0A17CF3 | 78                  | 99…104                | 0.001          |

One founder topology becomes dozens; the population spans the founder's hundred connections in
**both** directions, so structural mutation is not a ratchet; and on two of three seeds a memory
register arose by ordinary mutation and was still present at tick 10 000.

The registers stay rare in an unseeded world, and that is a finding rather than a shortfall. A
newly switched-on unit has all-zero weights, because that is what `createFounderBrainWeights`
leaves behind it — so it does nothing at all until drift gives it a role, while costing from the
first tick. The useless intermediate is a real evolutionary obstacle, not an artefact, and it is
exactly why the accessibility rule's method is a seeded selection experiment: ADR 0029 §5a made
the same point for morphology, where a population founded on one genome has no variation to
sort until mutation supplies it, and that takes far more generations than a gate can run.

## 10. Cost

Per organism: 82 bytes of topology genome, 352 bytes of weights (was 800 for 400 weights — now
1152 for 576), and 32 bytes of authoritative neural state. Inference gained five mask tests per
connection, which is a branch against work the loop was doing anyway, and gained the memory
write pass — `BRAIN_MEMORY_COUNT × BRAIN_HIDDEN_COUNT` products, bounded by constants.

The one genuinely new per-tick cost is `neuralUpkeep`, which popcounts 41 words per organism per
tick inside the physiology phase. That is measurable and was measured rather than assumed; if it
proves significant at population it becomes a value cached at spawn beside the phenotype, which
is legitimate because the topology cannot change during a life.
