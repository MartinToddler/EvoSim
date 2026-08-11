# 09 — Future Architecture (Do Not Implement in MVP)

This document prevents early architecture from blocking likely extensions.

## 1. Sexual reproduction

Later additions can include:

- mate sensing;
- compatibility;
- two parent IDs;
- recombination/crossover;
- mate-choice output;
- reproductive isolation.

Current reproduction code should be modular enough to replace copy/mutate with recombine/mutate, but do not build an elaborate abstraction now.

## 2. Evolving brain topology

Potential NEAT-like operations:

- add connection;
- add neuron;
- disable connection;
- innovation IDs.

Encapsulate fixed 400-weight brain operations so ecology code does not index raw weights everywhere.

## 3. Aquatic ecology

Future:

- water habitat;
- swim locomotion;
- aquatic food field;
- land/water adaptation.

Centralize current water hazard behavior rather than hardcoding it across modules.

## 4. Pathogens/parasites

Potential separate agent/state system driving coevolution. Major complexity; post-MVP only.

## 5. Niche construction

Organisms may later alter environment:

- seed/fertilize plants;
- create nests;
- modify terrain/resources.

Environmental update architecture should permit engine-generated deltas later.

## 6. Communication

Future signal outputs + signal sensors with energy cost could enable social behavior without scripted “herd” roles.

## 7. Complex body genome

Segments/organs/appendages would replace current procedural phenotype. Keep renderer mapping modular.

## 8. Server-continuous worlds

Future architecture:

```text
Client <-> API/WebSocket <-> world metadata DB
                         <-> simulation workers
                         <-> object storage snapshots
```

Pure engine can run server-side.

This solves mobile/browser suspension but is unnecessary for MVP.

## 9. Cloud saves/accounts

Later add authentication, object storage sync and conflict policy. World IDs should already be globally unique-style identifiers.

## 10. Sharing

A deterministic world can theoretically be represented by engine version + seed + config + command history, but long histories are better shared with checkpoints.

## 11. Guided experiments

Examples:

- create two descendant species without genome editing;
- create carnivorous lineage;
- survive +10°C change;
- compare control/intervention branches.

Challenges inspect outputs only and never alter selection rules.

## 12. Narrative historian

Future AI-generated summary may explain likely mechanisms from measured stats/events. It must be non-authoritative and clearly distinguish inference from observed data.

## 13. Rust/WASM migration

Only after profiling:

1. benchmark TS bottleneck;
2. port stable hot module or engine;
3. keep Worker protocol;
4. require deterministic regression equivalence where possible;
5. measure actual improvement.
