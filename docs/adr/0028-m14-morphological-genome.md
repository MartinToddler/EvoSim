# ADR 0028 — M14: the morphological genome

Status: accepted · Date: 2026-08-16 · Engine 0.8.0 → **0.9.0** · Protocol 9 → **10** ·
Snapshot schema 8 → **9** · Config schema 7 → **8** · Render snapshot layout 1 → **2**

M14 gives organisms a body that is inherited, evolvable, continuously variable and drawn from
the genome rather than chosen from a set of pictures. It is the first EvoSim 2.0 milestone and
the substrate M15 turns into physics.

## 1. The pipeline, and why each stage exists

```text
MorphologyGenotype        27 Uint16 genes, inherited and mutated like ecological genes
        ↓                 deriveMorphology — pure, bounded, no world state
MorphologyPhenotype       a derived SoA cache; never hashed, never serialized
        ↓                 writeMorphChannels — 27 bytes per organism
render snapshot channels  the DEVELOPED body, on the wire
        ↓                 buildMorphologyGeometry + paintMorphology
procedural geometry       polygons, in the renderer only
```

Three properties fall out of that shape and all three are tested:

- **Same genotype ⇒ same phenotype.** Development reads the genome and the config, nothing
  else — no position, no tick, no PRNG. That is what makes the phenotype safe to leave out of
  the state hash and recompute on restore, exactly like `PhenotypeStore`.
- **Same phenotype ⇒ same drawing.** Nothing downstream of the engine is random, so the
  channel block is a complete description of the picture — which is what makes it usable as a
  texture-cache key.
- **The renderer never develops anything.** What crosses the wire is the interpreter's output,
  not genes. A second copy of the developmental rules in the renderer would eventually
  disagree with the first, and the day it did, the picture would stop being a projection of
  the simulation.

## 2. What the genome contains, and what it deliberately does not

27 loci: body length, width, front and rear taper, segment count and proportion; appendage pair
count, placement, length, thickness, angle and front/rear specialization; head proportion,
mouth size, sensory size and placement; tail length, width and taper; armor coverage, plate
expression and distribution; primary and secondary pigment shift, contrast, pattern frequency
and orientation.

**Aspect ratio is derived, not a gene.** `docs/11 §M14` lists it, but an independent aspect
locus would be a third way to say what length and width already say, and would let a genome
disagree with its own body about what shape it is. The phenotype exposes `aspectQ`; nothing
stores it.

**Scale is not here.** `Gene.AdultSize` decides how big an organism is; every length in this
genome is a Q multiple of the adult radius. Keeping them apart lets a lineage evolve a long
thin body at any size, and stops morphology from silently re-deciding a quantity the ecological
genome already selects on.

**No gene is named for an animal or a role.** A test asserts it (`/wolf|tiger|predator|…/`).
There is no template table anywhere: every body is one point in a 27-dimensional continuous
space, and two lineages that look unrelated got there by drifting apart in it.

## 3. Decisions worth recording

### 3a. Two loci are integers, and they get their own mutation class

Segment count and appendage-pair count are read as small integers over configured ranges. A
continuous perturbation on those loci would do nothing at all most of the time and flip the
count when a genome happened to sit at a bucket edge — which makes gaining a segment an
artefact of position rather than an event.

So the structural class moves the **derived count** by exactly ±1 and rewrites the gene to the
**centre** of the destination bucket. Discrete, bounded, and stable against the small mutations
that follow it. At the ends of the range the step reflects inward instead of clamping in place,
because a clamped step is a silent no-op that would bias lineages toward parking at the bounds.

`structuralGeneFromCount` lands mid-bucket for the same reason, so a founder cannot flip its
segment count on the first small mutation.

### 3b. The wire carries a developed body in 27 bytes, on a fixed scale

Morphology never changes during a life, so this block is identical every frame — which makes it
the cheapest thing in the snapshot to make small. One byte per channel is well past what any
zoom level can show, and the addition is 27 bytes against the 32 the snapshot already carried
per organism.

Channels that can exceed 1.0 (body extents, tail, appendage length) are quantized against a
**fixed** constant, `MORPH_MAGNITUDE_SCALE = 10`, not against the config's silhouette ceiling.
The renderer decodes a snapshot without being told the simulation config, and a quantization
that moved with tuning would make two builds read the same bytes differently. `validateConfig`
keeps `maxSilhouetteExtentQ` at or below `MORPH_MAGNITUDE_SCALE × Q` so nothing saturates.

### 3c. Two LODs, because a procedural body cannot be free

Drawing 8 000 procedural bodies per frame is not affordable, and a texture cache keyed on a
continuous genome has no bound on distinct keys. The split follows the LOD structure docs/06 §3
already describes:

- **Particle layer (thousands).** The shared teardrop, stretched to the developed body's
  proportions and painted with its primary pigment. One draw call, and a long thin lineage
  reads as long and thin among thousands.
- **Detail layer (budgeted).** The full procedural body — segments, appendages, head, tail,
  plating, pattern — from a texture generated on first sight and cached. The cache is only
  consulted for organisms on the detail layer, which has a hard budget, so the number of
  distinct keys requested in one frame cannot exceed it; sizing the cache above that budget
  makes thrashing impossible rather than merely unlikely.

The detail texture bakes both pigments rather than being tinted, because a single sprite tint
multiplies one colour over the whole sprite and would erase the pattern. Health is applied as a
neutral grey tint on top, which darkens both pigments together — the same principle
`organismTint` already uses for hue.

A `MORPH_PARTICLE_GAIN` of 1.3 restores the apparent size the pre-M14 sprite had without
touching the ratio between the axes: shape stays entirely the engine's, and only overall
presence is the renderer's.

### 3d. A body that would overflow its frame is shrunk, not clipped

The sprite frame is derived from the wire scale so every expressible body fits, and
`validateConfig` bounds the config below it. The geometry builder still computes a `fitScale`
and shrinks uniformly if a channel block would overflow — which can only happen for bytes no
legal config can emit. Clipping would silently amputate a tail and read as a short lineage;
shrinking is visibly wrong instead of invisibly wrong. A test pins `fitScale === 1` for every
body `DEFAULT_CONFIG` can grow, so the guard cannot quietly start engaging.

### 3e. The gallery uses the production path or it is worthless

`?view=morphology` develops bodies with `deriveMorphology`, encodes them with
`writeMorphChannels` and paints them with `paintMorphology` — the same three functions the app
uses. A gallery drawn any other way would be an illustration of what the code was supposed to
do.

## 4. Why every hash moved

Engine 0.9.0 is an intentional authoritative change:

- the morphological genome is inherited state, so it joins `GenomeStore.hashInto` and the
  canonical stream;
- mutation gains 27 classification draws per birth between the ecological block and the brain,
  so the PRNG stream shifts from the first birth onwards.

Morphology has **no physical consequence yet** — that is M15 — so what changed ecologically is
the random stream, not the rules. Tick 0 moves through the config digest and the founder
bodies; the trajectory diverges from the first birth.

Regenerated: the six golden fixture checkpoints, the mutation golden (a single birth now draws
599 PRNG words, was 572; the fixture gained a `morphGenes` array), and both 100 000-tick soak
hashes.

## 5. The soak fixture was a coin flip, and this pass makes it an instrument

Regenerating the populated soak hash exposed something worth stating plainly: **under engine
0.9.0's stream the soak world goes extinct at ~tick 70 000**, where 0.8.0 reported 766 alive at
100 000.

That is not an M14 regression, and the evidence is direct:

- The same fixture on other seeds survives: `0xE0A13F15` finishes at 337 (trough 64),
  `0xE0A17CF3` at 324 (trough 44).
- The fixture seed's own trajectory oscillates violently — peaks of 1 704 / 2 419 / 1 317
  against troughs of 43 / 103 / 132 / 162 / 170 — so reaching 100 000 ticks was always a coin
  flip, and 0.8.0's 766 was one draw from a boom phase.
- The shipped ecology is unaffected: a twelve-seed sweep of `DEFAULT_CONFIG` at 10 000 ticks
  gives populations of 1 793 – 5 740 with millions of meat units eaten, in line with the
  numbers ADR 0026 §1a reproduced independently on 0.8.0.

A soak that survives on a coin flip cannot do its job, which is to run 100 000 ticks looking
for numeric, identity, resource and growth pathologies. The fixture world is test scaffolding —
not shipped biology — so this pass enlarges it until its troughs are not near-extinction. No
value in `DEFAULT_CONFIG` was touched, and no assertion was weakened.

## 6. Release gate 6 was a lottery ticket, and this pass makes it an experiment

The second thing regenerating goldens exposed. `ecologicalSpeciation.test.ts` — MVP release
gate 6, confirmed by execution in ADR 0026 §O07 — **fails on engine 0.9.0**: no automatic
species split by tick 60 000, and a probe run out to tick 88 000 found none there either. The
0.8.0 run split at ~tick 45 000.

The diagnosis is not "M14 broke speciation". It is that the scenario could not have been
reliable in the first place, and the reason is visible in the config rather than in the trace:

**the world's temperature cline is symmetric about the equator.** `poleTemperatureDropCentiC`
cools toward _either_ pole edge, so once the flooded channel cut the continent in two, the
northern and southern demes were isolated in environments that were mirror images of each
other. Nothing was selecting them apart. The only force separating their trait centroids was
**drift**, and drift crossed the detector's threshold at tick ~45 000 on one random stream and
had not crossed it by tick 88 000 on another — same world, same rules, different coin flips.

ADR 0027 §3b names this failure mode explicitly and forbids it: _"Do not demand a brittle story
at a fixed tick and seed."_ A speciation gate whose outcome depends on which coin flips a
lineage happened to get is not evidence that speciation is reachable.

So the scenario is now **selection-driven**. Immediately after the channel opens, ordinary
`PaintTemperature` commands paint the north cold and the south hot, in persistent local
offsets, putting the two demes 24 °C apart. `Gene.ThermalOptimum` is then pushed in opposite
directions by realized survival and reproduction. No fitness is assigned, no organism is moved,
no species is declared by hand, and every command is an ordinary player intervention the game
already exposes.

Measured, with a healthy population throughout (300 – 2 300 organisms): **the detector declares
the split by tick 73 000.** `SCENARIO_SPLIT_HORIZON` moves 60 000 → 90 000, ~23 % headroom.

One alternative was measured and rejected. Eight passes instead of three (hemispheres 64 °C
apart) also produces a split, at tick 78 000 — but it is a mass-extinction event first: the
population collapses to tens and oscillates between 26 and 650. That trades one lottery for
another. What the scenario needs is a _different_ optimum on each side, not a lethal one on one
side.

The cost is honest and it is real: the gate now steps up to 90 000 ticks on a 192² world, over
an hour of suite time. Every cheaper option tilts the experiment — raising the mutation rate,
lowering the split threshold, or shrinking the world until its centroids are noise — and a gate
that has been tilted proves nothing.

## 7. Cost

Per organism: 27 Uint16 genes (54 bytes) of authoritative state, a derived morphology cache of
30 arrays, and 27 bytes per organism in each pooled render snapshot buffer. Development is a
fixed sequence of bounded mappings with no loop whose trip count depends on the genome, so its
cost is the same for every body.

Bounded by construction and enforced by `validateConfig`: at most 8 segments, 6 appendage pairs
and 7 pattern bands, whatever a config asks for.
