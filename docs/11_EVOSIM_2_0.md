# 11 — EvoSim 2.0

> Status: approved roadmap · Opened 2026-08-16 on engine 0.8.0 / protocol 9 · Supersedes the
> "do not implement in MVP" half of `docs/09_FUTURE_ARCHITECTURE.md` **only** on the schedule
> below.

The MVP (Milestones 0–13, A22–A25 and the two post-A25 corrective passes) delivered a
deterministic world in which organisms with 16 ecological genes and a fixed 20→12→5 network
live, feed, fight, reproduce, mutate, speciate and go extinct — savable, rewindable and
branchable. What it did **not** deliver is a world where evolution has much room to be
surprising: one body plan, one brain shape, one food type that matters, one stationary
climate, one reproductive mode, one trophic level that ever really pays.

EvoSim 2.0 is twelve milestones that widen the evolutionary search space without giving up a
single determinism or purity guarantee. Its organising principle is stated once, in ADR 0027,
and enforced by `CLAUDE.md`:

> **Emergence first.** The engine provides mechanisms, costs and information. It never
> provides a role, a strategy or a plan. Every biological category a user recognises —
> predator, herd, colony, family, tribe — must be a *label the analytics derived from measured
> behaviour*, never a branch the simulation took.

## 1. What is now approved, and when

| Milestone | System                                | One-line objective                                                       |
| --------- | ------------------------------------- | ------------------------------------------------------------------------ |
| **M14**   | Morphological Genome                  | Bodies are inherited, evolvable and procedurally drawn — not templates.   |
| **M15**   | Functional Morphology                 | The body you can see is the body the physics uses.                        |
| **M16**   | Evolvable Brain & Memory              | Bounded evolvable topology and generic recurrent memory.                  |
| **M17**   | Rich Ecology & Niches                 | Several genuinely different ways to make a living.                        |
| **M18**   | Climate & Natural Events              | A world that stops standing still, through the environment.               |
| **M19**   | Sexual Reproduction & Recombination   | Recombination, evolvable compatibility, behavioural mate choice.          |
| **M20**   | Evolving Plants & Coevolution         | Producers evolve too, and push back.                                      |
| **M21**   | Pathogens & Immune Evolution          | Density becomes a cost; resistance becomes reachable.                     |
| **M22**   | Emergent Communication                | Neutral signal channels with no meaning assigned in code.                 |
| **M23**   | Emergent Sociality & Niche Constr.    | Transfer, carrying, stigmergy and material — no group objects.            |
| **M24**   | Geographic Isolation & Macroevolution | Geography as the engine of divergence.                                    |
| **M25**   | Life Laboratory                       | Scientific intervention, branch-first, fully replayable.                  |

Nothing in a later row may be implemented while an earlier row is open. The staging is not
bureaucracy: each milestone is the *substrate* the next one evolves on, and building M23
sociality before M16 memory or M22 signals exist would force the engine to fake the parts that
are missing — which is exactly how scripted biology gets in.

## 2. The four contracts every milestone inherits

### 2a. Determinism

`ENGINE_VERSION` + seed + authoritative config + canonical command history + target tick ⇒
byte-identical authoritative state, on any machine, in Worker or Node. No `Math.random`, no
wall clock, no render cadence, no device timing, no pointer frequency. Every new stochastic
process — mutation, pathogen transmission, climate noise, recombination crossover points —
draws from the seeded project PRNG or from stateless position/tick hashes, and every tie
breaks explicitly (normally on lowest `entityId`).

### 2b. Authoritative state is snapshot-, rewind- and branch-safe

Any value that can affect a future tick must be serialized, restored, hashed where
appropriate, and survive save → load → rewind → branch unchanged. This is the rule that most
often decides an implementation: recurrent brain state (M16), active climate events (M18),
pathogen strain tables (M21), signal fields (M22) and deposited material (M23) are all
authoritative, and therefore all pay the snapshot tax. Derived caches (phenotypes, gradients,
render params) are recomputed instead, and stay out of the hash.

### 2c. Engine purity

`packages/engine` stays Node-runnable, React-free, Pixi-free, DOM-free and IndexedDB-free.
The renderer draws what the engine already decided; the UI labels what the engine already
measured. Neither ever decides biology.

### 2d. Every benefit has a cost

A trait that is free is not a trait, it is a default that will fixate and never move again.
Each milestone below names its trade-offs explicitly, and the final audit re-checks all of
them for traits that converge trivially to their maximum or minimum.

## 3. Milestone specifications

### M14 — Morphological Genome

**Pipeline.** `MorphologyGenotype → deterministic developmental interpreter →
MorphologyPhenotype → procedural geometry parameters`. Same genotype ⇒ same phenotype ⇒ same
drawing, everywhere, forever.

**Genome content** (bounded, no recursive grammar): body length, width, aspect, front and rear
taper, segment count and proportions; appendage pair count, placement, length, thickness,
angle, front/rear specialisation; head proportion, mouth-structure size, sensory-structure
size and placement; tail extension, width and taper; armor coverage and plate expression and
distribution; primary and secondary pigment, contrast, pattern frequency and orientation.

**Explicitly forbidden:** any gene, enum, constant or asset named for a real animal or an
ecological role ("wolf body", "predator plan", "herbivore head").

**Inheritance and mutation.** Morphology genes inherit like ecological genes: small continuous
drift, rarer large jumps, bounded structural changes (a segment or appendage pair appearing or
disappearing). All mutation is PRNG-driven inside the engine; the renderer contributes no
randomness whatsoever.

**Acceptance.** The live application shows visibly inherited morphological diversity: children
resemble parents, distant lineages can look clearly different, and the debug gallery renders
through the exact production path.

### M15 — Functional Morphology

**Chain.** `genome → visible body → PhysicalPhenotype → survival/reproduction → selection`.
One centralized deterministic derivation, so the picture and the physics can never disagree.

**Effects.** Body mass, collision extent, energy storage, basal metabolism, development cost,
force, top speed, acceleration, agility, terrain performance, armor value, physical attack
capability, sensory capability and its upkeep, thermal properties, offspring construction
cost.

**Trade-offs.** Large body: more reserves and mass, more basal drain, slower growth, worse
agility. Armor: protection bought with mass, growth and speed. Long locomotor appendages:
movement bought with development time and turning cost. Large sensory structures: information
bought with maintenance. Large feeding/attack structures: capability bought with mass and
growth.

**Acceptance.** Two controlled ordinary-engine environments select in *opposite* morphological
directions using nothing but realized survival and reproduction — no assigned fitness — and no
single morphology dominates both.

### M16 — Evolvable Brain & Memory

**Bounded evolvable network.** Per-organism masks over a hard-capped topology decide which
sensory inputs, hidden units, connections and recurrent links are active; weights and biases
evolve as before. Strict maxima everywhere: no unbounded NEAT growth, no per-organism graph
allocation.

**Memory.** Recurrent neuron state and a small bank of generic registers the network itself
gates. Registers are numbered, not named: `memory0`, not `homeX`. Memory is authoritative and
survives snapshot, load, rewind and branch.

**Cost.** Active neurons, active connections, retained memory and active sensory channels all
draw metabolic and developmental energy, so maximum complexity is never automatically optimal.

**Acceptance.** Fixtures prove the architecture can *represent* food approach, threat
avoidance, state-dependent action, temporal alternation and a persistent location strategy
built from generic memory and cues. Fixtures only — none of these are installed into any
organism.

### M17 — Rich Ecology & Niches

**Resource modes.** Low vegetation (common, cheap, fast), tough vegetation (dense, slow, hard
to process), fruit (localized, valuable, intermittent), roots (persistent, extraction cost),
defended/toxic growth (attractive but needs resistance), and meat/carrion (the existing
predation and scavenging path).

**No role classes.** No `Grazer`, `Browser`, `Frugivore`, `Scavenger` type, enum or branch.
Processing ability is continuous and genetic; physical access is morphological. Poorly matched
food is still edible, badly — categorical "you cannot eat this" gates create fitness valleys
that block every evolutionary intermediate, which is the exact defect the post-A25 pass
removed from carcass feeding.

**Spatial ecology.** Resource availability follows temperature, moisture, fertility, biome and
terrain, so different *places* offer different livings.

**Sensors.** Generic per-resource information only. There is no `nearestBestFoodForMe` input;
the brain does the ranking.

**Acceptance.** Multi-seed controlled runs in grass-rich, fruit-patchy, toxin-rich, root-rich
and carrion-rich worlds show no single resource strategy is structurally universal.

### M18 — Climate & Natural Events

**Causal chain.** `event → environment → resource/physiology change → survival/reproduction →
selection`. Never `event → kill N random organisms`.

**Climate.** Deterministic simulation-time seasons, regional variation and longer drift
cycles. Simulation time only — never a wall clock.

**Events.** Drought, wet period, heat wave, cold snap, deterministic wildfire (spreading on
fuel, moisture and neighbourhood) and a rare major impact event. Active events are
authoritative state and survive snapshot, load, rewind and branch.

**Acceptance.** Controlled tests show environmental variation changes realized reproductive
success, and long runs show selection shifts that are meaningful without being permanently
catastrophic.

### M19 — Sexual Reproduction & Recombination

**Recombination.** Deterministic crossover across ecological genes, morphology genes and the
neural genome, with mutation applied after recombination.

**Compatibility is not species.** `if (sameSpecies) allowMating` is forbidden — species is an
analytical label, and using it authoritatively would make the taxonomy cause the biology.
Compatibility comes from evolvable genetic/phenotypic distance mechanisms.

**Mate choice is behaviour.** Mating is a decision the brain makes from ordinary sensory input
and ordinary outputs. No `findNearestMate()` shortcut.

**Sexual selection.** Inherited display traits and inherited preferences both evolve and
interact. The engine never defines what is attractive.

**Costs.** Search time, energy, opportunity and reproductive investment.

**Acceptance.** Recombination demonstrably expands genetic combinations; mate choice and
sexual-selection pathways are evolutionarily reachable with no species-role hardcoding;
genealogy records two parents.

### M20 — Evolving Plants & Coevolution

**Representation.** Bounded evolving plant populations per patch/lineage — not one agent per
blade of grass.

**Traits.** Growth rate, energy density, moisture and temperature preference, chemical
defense, physical defense, regeneration, dispersal and allocation strategy.

**Trade-offs.** Defense is paid for in growth or reproduction; fast growth is paid for in
density, defense or efficiency.

**Acceptance.** Controlled ordinary-engine scenarios show *reciprocal* trait change: consumer
pressure moves plant defense, and plant defense moves consumer processing.

### M21 — Pathogens & Immune Evolution

**Representation.** A bounded table of strains/lineages, not millions of pathogen agents.
Traits: transmissibility, virulence, duration, host exploitation, antigenic signature,
environmental persistence.

**Hosts.** Recognition, resistance, tolerance and immune investment — all costly.

**Transmission.** Emerges from proximity, contact and density, computed on the existing
spatial index.

**No named diseases.** Immunity is matched against evolving antigenic signatures, never
against a disease ID, so a mutating strain can escape an adapted host population.

**Acceptance.** Dense populations experience real disease pressure, resistance can evolve, and
maximum immune investment is not automatically optimal.

### M22 — Emergent Communication

**Channels.** A small bounded set of numbered signals (`signal0`, `signal1`, …) that organisms
can emit and sense, optionally through a bounded decaying environmental field.

**No semantics.** No `dangerSignal`, `foodSignal`, `mateSignal` or `homeSignal`, in any
identifier or any branch. What a channel means, if anything, is for evolution to decide.

**Cost.** Emission and reception both cost energy and neural complexity.

**Analytics.** The UI may report a measured correlation ("signal 2 is usually emitted shortly
before an attack"). The engine must never turn that correlation into a rule.

**Acceptance.** A controlled evolutionary scenario shows a channel acquiring useful
information correlation without its meaning being written anywhere in code.

### M23 — Emergent Sociality & Niche Construction

**Recognition.** Generic evolvable identity cues and a generic similarity sense. No
`isFamily`, `isFriend` or `isSameSpecies` input.

**Transfer.** Voluntary, bounded, brain-initiated energy/resource transfer, with a cost.

**Carrying.** Generic `pick up` / `carry` / `drop` — never `storeAtHome`.

**Stigmergy.** Neutral environmental traces that decay and diffuse, are sensed locally, and
cost something to deposit.

**Niche construction.** Low-level material collection, deposition and removal. Material acts
through *generic physical rules only* — movement resistance, thermal buffering, occlusion,
resource protection. There is no `buildNest()`, `buildWall()` or `buildVillage()`, and no
authoritative group, colony or territory object. Clustering analytics are derived and
observational.

**Acceptance.** Controlled scenarios show ordinary selection can favour kin-biased transfer,
caching, stigmergic coordination and persistent local resource use — without a single social
category existing in authoritative code.

### M24 — Geographic Isolation & Macroevolution

**Dynamics.** Bounded deterministic sea-level variation, island isolation, land bridges,
corridors and barriers, and slow habitat change.

**Gene flow.** Geography changes ordinary encounter and reproduction rates. Populations are
never isolated by ID.

**Secondary contact.** Separated populations can meet again; what happens is decided by the
traits they evolved, not by a scripted outcome.

**Derived macro events.** Founder event, bottleneck, adaptive radiation, recolonisation,
secondary contact and mass extinction are *labels the history layer applies to measurements*.

**Acceptance.** The required scenario — ancestral population → geographic separation →
different pressures → ordinary mutation and reproduction → persistent divergence → automatic
species split — runs on the ordinary engine with no manual species assignment.

### M25 — Life Laboratory

**Interventions.** Genome inspection (ecological, morphological, neural, genealogical,
species), clone, explicit gene edit with old/new values shown, deterministic experimental
mutagenesis, founder translocation, and explicit bottleneck.

**Discipline.** Every intervention is an explicit versioned canonical command: deterministic,
replay-safe, branch-safe and visible in history. Nothing is ever silently applied, and no
intervention hides its origin.

**Branch-first science.** Destructive experiments offer to branch first, so a control world
and a treated world can be run side by side.

**Comparison.** Branches compare on population, species, trait distributions, morphology,
resource use, predation, disease and social/communication metrics — never on a hidden
universal fitness score.

**Acceptance.** A user can select an organism, inspect its genetics, branch, modify genes or
environment or population, simulate, and compare against the control, with deterministic
replay intact throughout.

## 4. What is still out of scope

Unchanged from the MVP contract, and not approved by this roadmap:

- multiplayer;
- authentication and accounts;
- cloud saves and server-side persistent worlds;
- 3D;
- direct WASD control of an organism;
- unbounded NEAT topology growth;
- aquatic organisms as a separate locomotion mode.

## 5. Progress and evidence

Per-stage evidence — commit SHA, versions, `pnpm verify` result, key tests, performance and
evolutionary observations, deployment URL and deferred issues — is recorded in
`docs/EVOSIM_2_PROGRESS.md`. `TASKS.md` remains the authoritative implementation checklist.
Architectural decisions are recorded as ADRs, starting with **ADR 0027 — Emergence first**.
