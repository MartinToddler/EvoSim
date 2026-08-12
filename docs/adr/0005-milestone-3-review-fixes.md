# ADR 0005 — Milestone 3 independent review: findings and fixes

Status: accepted · Date: 2026-08-12 · Engine 0.3.0 → 0.3.1 · No new tasks

An independent review of Milestone 3 (ADR 0004) looked for the failure classes that determinism
work characteristically hides: O(N²) loops, per-tick allocation, order bias, slot-versus-entity-ID
confusion, free-list nondeterminism, ID reuse, integer overflow, sensors that depend on iteration
order, energy created from nothing, entities acting after death, caches that influence state
without being hashed or provably recomputable, arrays missing from the hash, and snapshots missing
future-influencing state.

Milestone 3 held up on all but one of them. This ADR records the one authoritative defect, two
robustness defects, and the checks that were run to reach that conclusion.

## 1. Coincident bodies separated in slot order, not entity-ID order

`resolveTerrainAndSoftCollisions` handles two organisms at exactly the same position by deriving a
direction from a stateless hash, as docs/03 §13 requires. It hashed
`(entityId[lowerSlot], entityId[higherSlot])` and always pushed the higher-slot organism along the
drawn angle.

Slots are recycled and entity IDs are not, so from Milestone 4 onward the same two organisms can
hold either slot depending only on who died recently. The hash arguments would swap with them, the
drawn angle would change, and the pair would fly apart in a different direction — an internal
storage detail deciding an authoritative outcome, which is exactly what CLAUDE.md's "tie-breaking
must be explicit, normally lowest `entityId`" rule exists to prevent.

Measured before the fix: the same two identities, given swapped slots, ended one tick five
sub-units apart in x. Both the hash arguments and the push sign are now ordered by entity ID, so
the drawn angle always points at the higher ID and the outcome is a function of identity alone.

The reference world never reaches the branch — no two organisms occupy exactly the same position at
any tick of the 10 000-tick fixture — so **every golden hash is unchanged**. It is reachable in
general: `spawnFounderPopulation` falls back to the region centre after 64 rejected placement
attempts, and several such founders would coincide exactly.

`ENGINE_VERSION` is bumped to 0.3.1 anyway. The engine computes something different in a reachable
state, and the version is what tells a stored snapshot whether the engine that wrote it and the
engine reading it agree about the rules; snapshot restore is an exact-match check, so a 0.3.0 save
is now correctly refused rather than silently continued under changed semantics.

## 2. `allocateSlot` could leave a slot neither live nor free

The entity-ID exhaustion assertion ran _after_ the free stack had been popped. If it ever fired,
the popped slot would be lost: not alive, not on the free list, and never reusable. The cap check
and the assertion now both run before anything is mutated.

This is unreachable without 2^32 births, but it is the kind of unreachable that stops being
unreachable through a restore, which is why the regression test reaches it through
`adoptSlotState`.

## 3. Snapshot restore trusted a malformed free list

`adoptSlotState` checked that every restored free slot was in range and not alive, but not that
each appeared **once**, and not that every used slot was accounted for. A free list naming the same
slot twice would hand one slot to two organisms — precisely the slot aliasing the ID/slot split
exists to prevent — and a list that omitted a dead slot would leak it forever.

Restore now rejects duplicates and enforces the invariant the live engine maintains on every
allocate and release: `liveCount + freeCount === slotHighWater`.

## 4. What was checked and found correct

- **No O(N²) over the population.** Vision and crowding go through the spatial hash; feeding
  reaches claimants through a per-cell chain; soft collisions visit a 3×3 neighbourhood. Cost is
  linear in population at fixed density and quadratic only in _local_ density, which is inherent to
  a uniform grid. Measured: 17.1 ms/tick at 5000 organisms in a 1200 LU circle, 6.1 ms at 2000 —
  inside the docs/07 §8 budget. Packing 8000 organisms into the 120 LU founder radius (≈100× that
  density) costs 292 ms/tick; reproduction will create local crowding, so this is the number to
  watch in Milestone 4.
- **No per-tick allocation.** 2000 ticks at 1000 organisms grew the heap by 36 kB, i.e. nothing.
- **Feeding conserves biomass exactly** for demand/biomass ratios from 0 to saturation, never
  over-grants, never leaves a cell negative, and hands the integer remainder to the lowest entity
  IDs regardless of slot order.
- **Energy is only ever created from biomass**, and never goes negative: upkeep floors it at zero
  and converts the shortfall into health damage; growth and healing spend only what is there.
- **Nothing acts after death.** Deaths are marked during physiology and finalized in phase 13; the
  spatial index and every query skip non-live slots.
- **The hash and the snapshot cover all authoritative state.** All 22 organism arrays, the slot
  bookkeeping, the free list, the ID counter, the death counters, the genomes, the brains and all
  ten environment arrays. The three caches that exist — phenotype, passability, spatial index — are
  pure functions of hashed state, recomputed at fixed points.
- **The tie-breaks hold.** Equidistant vision candidates resolve to the lower entity ID with their
  IDs swapped between slots; the free list is LIFO; entity IDs are monotonic and never reused.
- **Integer math stays exact.** `isqrt` is exact over 20 000 sampled values and at the boundaries;
  `powQ` is monotone and exact at both endpoints; `geneToQ`/`geneFromQ` round-trip for every value
  in `[0, Q]`; the inference accumulator is three orders of magnitude below 2^53 and the validator
  enforces that for any retuned topology.
- **ADR 0004 §1 is accurate.** Rebuilt with the literal docs/08 §20 eat bias of +0.10, the founder
  cohort records _zero_ lifetime intake and starves to extinction (tick 890 on the reference
  world). The recalibrated bias is justified.
- **Determinism and resume.** Two 10 000-tick runs agree at every checkpoint and match the golden
  fixture; snapshots taken at ticks 1, 2497, 2500 and 6050 resume to bit-identical state, including
  one taken off the environment-update cadence and one taken with a non-empty free list.

## 5. Observations recorded but not changed

- **Founder selection pressure is weak.** Across six seeds only the reference seed starves anyone
  (31 of 256); on the other five the whole cohort reaches its 6100-tick maximum age. With 256
  organisms on a 65 536-cell world and no reproduction there is almost nothing to compete for, so
  this is expected rather than wrong — but "viable but mediocre" (docs/07 §15) can only really be
  judged once Milestone 4 lets the population find its own density.
- **`plantEnergyEaten` counts gross intake.** Energy above `maxEnergy` is discarded but still
  counted. That is defensible for a lifetime _intake_ statistic and affects plant and meat equally,
  so the diet ratios Milestone 8 derives from it stay meaningful. Left as is; recorded because it
  is not stated anywhere else.
- **`spatialPost` is rebuilt every tick and read by nothing yet.** Phase 7 is part of the versioned
  tick order and Milestone 5 combat will read it; it costs 0.1 ms/tick, so it stays.
- **The per-cell remainder sort is insertion sort**, O(k²) in the claimants on one contested
  environment cell. It is the right shape for the handful of claimants a 16 LU cell normally holds,
  and it never allocates. If a milestone makes hundreds of organisms graze one cell, revisit.

## 6. Versioning

| Constant                  | Change            | Reason                                                                 |
| ------------------------- | ----------------- | ---------------------------------------------------------------------- |
| `ENGINE_VERSION`          | 0.3.0 → **0.3.1** | §1 changes what the engine computes for coincident bodies.             |
| `SNAPSHOT_SCHEMA_VERSION` | unchanged (4)     | No payload field changed; restore validates more strictly than before. |
| `CONFIG_SCHEMA_VERSION`   | unchanged (4)     | No config field changed.                                               |
| `PROTOCOL_VERSION`        | unchanged (1)     | No wire shape changed.                                                 |

Golden hashes are unchanged and the fixture records why.
