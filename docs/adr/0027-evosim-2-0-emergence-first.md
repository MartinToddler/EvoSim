# ADR 0027 — EvoSim 2.0: emergence first

Status: accepted · Date: 2026-08-16 · Engine 0.8.0 unchanged · Protocol 9 unchanged ·
Snapshot schema 8 unchanged · Config schema 7 unchanged

This ADR opens EvoSim 2.0. It changes no code and moves no hash. What it changes is the
contract: twelve systems the MVP explicitly forbade are now approved, on a schedule, under one
architectural rule that this document exists to state precisely enough to be enforceable.

## 1. Context

The MVP shipped a world that is deterministic, inspectable and honest, and whose evolution has
almost nowhere to go. Every organism has the same body plan drawn from one hue gene; the same
20→12→5 network with no state between ticks; one food type that matters; a stationary climate;
one reproductive mode; and — as ADR 0026 §1a measured — a diet that is 98 %+ plants on every
seed, because there is no other way to make a living that pays.

`docs/09_FUTURE_ARCHITECTURE.md` anticipated most of the additions and told the MVP to stay
out of their way. It succeeded: reproduction is modular, brain weight access is encapsulated,
the water hazard is centralized. The extensions are now approved, and the question this ADR
answers is _how to add them without turning an evolution simulator into a biology cartoon_.

That failure mode is specific and it is easy to fall into. It looks like this:

```ts
if (organism.role === Role.Predator && target.role === Role.Herbivore) attack(target);
if (isSameSpecies(a, b)) shareFood(a, b);
if (colony.hasNest) returnHome(organism);
```

Every line above is _cheaper to write_ than the mechanism it replaces, produces recognisable
behaviour immediately, and destroys the entire point of the project: nothing was discovered,
nothing can be surprising, and no user observation about the world is a finding about
evolution — it is a finding about the `if` statement.

## 2. Decision

**Emergence first.** The authoritative engine provides mechanisms, costs and information. It
never provides a role, a strategy, a plan or a category.

The rule has four operational parts.

### 2a. No authoritative behavior classes

No authoritative simulation decision may read a high-level biological category. The forbidden
list — `Predator`, `Herbivore`, `Grazer`, `Scavenger`, `Pack`, `Family`, `Nest`, `Colony`,
`Community`, `Tribe`, `Leader`, `Home`, `Village`, `CivilizationStage`, `SocialRole`,
`MatePreferencePreset` — is not exhaustive, it is a shape. The test is not the word, it is the
direction of causation: _does a category the observer invented determine what the simulation
does?_ If yes, it is a defect regardless of naming.

### 2b. No scripted behavior functions

No production-authoritative `huntTogether()`, `returnHome()`, `formPack()`, `buildNest()`,
`createCommunity()`, `buildVillage()`, `seekMateBySpecies()`, `followLeader()`. A function
whose name describes a _strategy_ rather than a _capability_ is almost always the defect: the
engine may expose "transfer energy to the organism in front of me", never "share food with my
family".

### 2c. Derived labels are allowed, and are the point

The distinction that makes the whole thing workable:

| Allowed — derived observational label                                                              | Forbidden — authoritative role                                         |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Analytics measure a lineage's intake over 5 000 ticks, find 78 % meat, and label it _carnivorous_. | The engine reads `role === "carnivore"` and changes feeding or attack. |
| History labels a spatial cluster of close kin that persists 20 000 ticks a _group_.                | Organisms get a `groupId` that makes them cooperate.                   |
| The UI notes `signal2` usually precedes an attack.                                                 | `signal2` is defined as `dangerSignal` and triggers a flee response.   |

Labels are downstream of measurement and have zero effect on any future tick. This is already
how `CarnivoreLineageDetected` works, and it is the pattern every 2.0 analytic follows.

### 2d. Every benefit has a cost

A capability with no cost is not evolvable — it fixates immediately and stops carrying
information. Every major evolvable benefit therefore needs a credible direct or indirect
trade-off: bigger body ⇒ more reserves, more basal drain; armor ⇒ protection, mass and speed;
bigger brain ⇒ behavioural capacity, metabolic and developmental cost; immunity ⇒ resistance,
energetic cost; signalling ⇒ information, energy; construction ⇒ advantage, material and time.

The MVP already enforces this in `derivePhenotype` — speed, vision, attack, armor, tolerance
and longevity all buy their capability with basal upkeep — and every 2.0 trait joins that
accounting.

## 3. Consequences

### 3a. Some things become harder to build, on purpose

"Organisms should form packs" is not implementable under this ADR. What is implementable is:
generic identity cues an organism can sense, a voluntary transfer action with a cost, memory
that can persist across ticks, and signal channels with no meaning — after which packs are a
thing selection may or may not produce, and either outcome is a result.

This is a real cost in effort and in certainty. It is accepted because the alternative
produces a simulator whose output is already known.

### 3b. Evolutionary reachability replaces "it works in a fixture"

A mechanism test proves a mechanism exists. It does not prove evolution can _find_ it, and
under this ADR finding it is the entire claim. So where a system is meant to evolve, the
milestone must also demonstrate an ordinary mutation + inheritance + selection pathway to the
behaviour, in a controlled environment running the ordinary engine with no assigned fitness.

Two guardrails on that requirement, learned from release gates 4 and 6 of the MVP:

- **Do not demand a brittle story at a fixed tick and seed.** "At tick 43 700 on seed X a
  lineage becomes carnivorous" is a lottery ticket, not a test.
- **Do demand reachability under ordinary rules.** Multi-seed, controlled pressure, realized
  reproductive success only. ADR 0025's ecological speciation scenario is the model: an
  ordinary world, an ordinary command, and the engine's own detector doing the concluding.

### 3c. Staged development is architectural, not procedural

Milestones may not be implemented ahead of their slot, because each is the substrate the next
evolves on. M16 provides memory but must not implement sociality; M19 provides sex but must
not implement hierarchy; M22 provides channels but must not assign meanings; M23 provides
material but must not implement nests; M24 enables isolation but must not create species by
hand. Building out of order forces the missing substrate to be faked — and a fake substrate is
scripted biology arriving through the back door.

### 3d. Boundedness is a hard requirement, not an optimisation

Thousands of organisms remain the target, so no 2.0 system may introduce unbounded recursive
morphology, unbounded topology growth, unlimited pathogen instances, an unlimited social
graph, unlimited construction objects or unlimited signal history. Everything is a bounded
structure with a configured maximum, sized for the population, and every per-organism addition
is measured against the tick budget it lands in.

### 3e. Determinism is not negotiated per milestone

Every 2.0 system inherits the existing contract in full: seeded PRNG only, no wall clock, no
render coupling, explicit tie-breaking, canonical hashing, and authoritative state that
survives snapshot, load, rewind and branch. Systems that carry live state across ticks —
recurrent memory, climate events, pathogen strains, signal fields, deposited material — pay
the serialization cost rather than being demoted to "close enough".

### 3f. The documentation is the source of truth

If a future prompt and the repository's documentation disagree, the disagreement is resolved
by _updating the architecture record first_ — this ADR, `CLAUDE.md`, `docs/11_EVOSIM_2_0.md` —
and only then writing the code. Silently overriding `CLAUDE.md` from a prompt is how a
contract stops meaning anything.

## 4. Alternatives considered

**Keep the MVP exclusions and tune the existing world instead.** Rejected: ADR 0025 and 0026
already did the tuning pass that was available, and the measured outcome was a stable,
correct, herbivorous monoculture. The ceiling is the mechanism set, not the constants.

**Add the systems without the emergence rule, and use roles where they are convenient.**
Rejected for the reason in §1: it converts findings about evolution into findings about
authored `if` statements, and it is not recoverable later — once a role exists, every
downstream system is written against it.

**Allow unbounded NEAT and unbounded agent-per-plant/pathogen modelling for biological
fidelity.** Rejected: both break the population target and both break determinism-friendly
bounded storage. Bounded evolvable topology and bounded strain/patch tables preserve the
evolutionary content at a fixed and measurable cost.

## 5. Enforcement

- `CLAUDE.md` carries the rule as a hard contract, including the approved-systems list, the
  staging rule, the trade-off rule, the reachability rule and the boundedness rule.
- Each milestone's own ADR records what it added, what it cost and what it measured.
- The final EvoSim 2.0 audit re-runs the search for authoritative biological categories across
  production code, and classifies every occurrence as derived-analytics or defect.
