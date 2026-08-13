# ADR 0009 — Milestone 5 review: predation, carrion and combat

Status: accepted · Date: 2026-08-13 · Engine 0.5.0 (unchanged) · Review of tasks F01–F08

Independent review of `ecology/CarcassStore.ts`, `ecology/carcasses.ts`, `ecology/combatClaims.ts`,
the carcass half of `ecology/feedingClaims.ts`, the carrion queries in `spatial/queries.ts` and the
carcass sensors in `brain/sensors.ts`, against the thirty risks in the review brief and the
eighteen mandated test scenarios.

**One defect was found and fixed, plus two test and documentation gaps.** The defect is a silent
break of the invariant this milestone rests on, but it is not reachable from `DEFAULT_CONFIG`, so
**`ENGINE_VERSION` stays 0.5.0, `CONFIG_SCHEMA_VERSION` stays 6 and every golden hash is
unchanged** — the same disposition ADR 0007 §0 reached for the Milestone 4 review, and for the same
reason: the fix rejects configurations that were already producing corrupt state, and changes
nothing about any world that was valid before.

## 0. Method

The previous agent's report was treated as a claim, not as evidence. Everything below was
re-derived: the phase order was read out of `SimulationEngine.step()` rather than out of the ADR,
and the properties were tested against hand-built states rather than inferred from the existing
suite passing.

The review's own probes were written **before** reading the corresponding shipped tests, and were
deliberately constructed so that **slot order and entity-ID order disagree**. That is the only
construction that can tell a real tie-break from an accident of iteration, and it is what surfaced
§3 below.

| Mandated verification                               | Result                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1v1, 2v1, 1v2, mutual lethal, multiple contributors | **Pass.** Verified against hand-built states, including a pile where every attacker converges on the lowest-ID target and the damage on each is asserted exactly.                          |
| Armor, cooldown, attack energy cost, invalid range  | **Pass.** Armor mitigates without ever granting immunity; the cooldown spaces attacks exactly `attackCooldownTicks` apart; an out-of-range swing costs nothing on 25 consecutive attempts. |
| Dead targets                                        | **Pass.** A released slot left in a stale post-movement index is neither targeted nor charged for.                                                                                         |
| Carcass creation exactly once, full lifecycle       | **Pass.** A second `finalizeDeaths` sweep creates no duplicate; create → eat → decay → release conserves meat exactly.                                                                     |
| Multiple feeders, meat conservation                 | **Pass.** Eight mouths against a 3-unit carcass take exactly 3 units in total and release the slot.                                                                                        |
| Deterministic predator/prey fixture                 | **Pass.** Reproduced through the real tick loop.                                                                                                                                           |
| Snapshot during active combat/carcass state         | **Pass**, strengthened — see §4.                                                                                                                                                           |
| Same seed/config run twice                          | **Pass.** Two independently built predation worlds agree on the state hash at **every one of 600 ticks**, over a run with real kills, carcasses and scavenging.                            |
| Long deterministic ecosystem soak                   | **Pass.** 800 ticks with a per-tick check of meat conservation, entity-ID uniqueness, carcass validity and energy/health bounds; plus the shipped 100 000-tick soak.                       |

**Which of these are now permanent tests.** The rows that found a gap were promoted into the suite
and are pinned from here on: the three slot-hostile tie-break tests (§3), the every-tick snapshot
window (§4) and the two storage-width tests (§1). The rest were **one-off review verifications** —
they confirmed a property the shipped suite already covers by a cheaper route, and were not kept,
because the suite already costs ~1 880 s and duplicating coverage at that price buys nothing. Where
a row above says something the shipped suite does not assert in that exact form — the 600-tick
same-seed comparison, the 800-tick invariant sweep, the 25 consecutive out-of-range swings, the
eight-mouth carcass — it is a statement about what this review ran, not about what CI will re-run.

## 1. Defect (P1): carcass meat silently truncated into its storage row

`CarcassStore.remainingMeat` is a `Uint32Array`; `totalMeatCreated` is a plain safe integer.
`carcassMeatUnits()` is `mass × meatPerMass` plus a bounded energy share, and `meatPerMass` was
validated only as a non-negative integer — with no upper bound at all.

So a configuration the validator **accepted** produced this:

```text
organism.carcass.meatPerMass = 3_000_000       // accepted before the fix
body worth                     6_075_000_948   // what carcassMeatUnits computed
stored in remainingMeat        1_780_033_652   // the Uint32 row wrapped
totalMeatCreated              += 6_075_000_948 // the counter kept the full amount

created == eaten + decayed + Σ remaining   →   6_075_000_948 == 1_780_033_652   ✗
```

4 294 967 296 units of meat conjured out of a storage width, with no error anywhere.

This matters more than the contrived constant suggests, because the identity it breaks is the one
ADR 0008 §2 names as **the** invariant of this milestone — the thing that stands in for energy
conservation now that bodies are an ecological energy source. It is asserted at three levels in the
shipped suite and swept every 997 ticks by the 100 000-tick soak, and all of those checks read
`totalMeatCreated` — so every one of them would have gone on passing while the world's carrion
accounting was wrong. A silent invariant violation that the invariant's own tests cannot see is
worth fixing whatever its reachability.

It is also exactly the class of defect ADR 0007 §2 fixed for `reproduction.reproductionCooldownTicks`
(70 000 stored in a Uint16 row became 4 464). That precedent settles the policy: **a field whose
value lands in a fixed-width row is bounded by that row's width, in the validator.**

**Fixed in two places, deliberately:**

1. `validateConfig` now computes the largest body the configuration can grow — mirroring
   `carcassMeatUnits` at full development, energy term included — and rejects any config whose
   worst-case carcass would not fit the row. This is what makes the failure unreachable rather than
   unlikely.
2. `CarcassStore.create` asserts the bound at the storage boundary. This is the guarantee that it
   can never happen _silently_ if some future path reaches the store without passing the validator,
   and it matches the class's existing philosophy for `consume`: a wrong amount fails loudly,
   because "silently trimming it would hide the bug while breaking conservation".

The bound is not tight enough to constrain tuning: the default `meatPerMass` is 3, and 1 000 000 —
five orders of magnitude above it — still validates. A test pins both ends.

## 2. Not fixed (P3): accumulated damage could wrap `Int32` under an absurd config

`scratch.damageAccumQ` is an `Int32Array`, and `combat.baseAttackDamageQ` is validated only as a
non-negative Q coefficient. With every organism in one pile attacking one target, the accumulator
overflows at roughly `baseAttackDamageQ > 49 × Q`, and a wrapped negative total would be skipped by
the `damage <= 0` guard — a lethal pile-up becoming a no-op.

**Reported and deliberately not fixed.** Health is capped at `Q`, so `baseAttackDamageQ = Q` already
one-shots any organism from full health; reaching the overflow needs a constant ~49× beyond
"instantly lethal" _and_ ~8 000 bodies in mutual contact. Unlike §1 this is not a config anyone
could arrive at by rescaling a unit — it is a config that is already meaningless before the
arithmetic fails — and the only available bound would be an invented ceiling on a field docs/08
leaves open. Recorded here so the next person meets it as a known limit rather than a surprise.

## 3. Test gap (P2): the attribution tie-break could not have failed

`combatClaims.test.ts` had a test named "breaks an equal-damage tie on the lower attacker entity
ID". It spawned `older` and then `younger`, so the lower entity ID also sat at the lower **slot**.
Entity ID and slot index agree in a freshly spawned world and only diverge once something has died
and its slot has been reused — which is precisely the situation the tie-break exists for. The test
would have passed identically against an implementation that simply kept the first attacker it
iterated over, i.e. against the slot-order bias the whole phase split exists to prevent.

The same held for target selection, which had **no** tie-break test at all: when two bodies are
equidistant, nothing pinned which one gets bitten.

The implementation turned out to be **correct** — `bestAttackerId` is compared on entity ID, and
`findContactTarget` breaks its distance tie on entity ID — but nothing in the suite would have
noticed if a refactor had reintroduced storage order. Three tests were added that free a slot,
hand it back to the _later-born_ organism, and assert that the winner is the one at the **higher**
slot:

- attribution: two identical attackers, equal damage, the lower entity ID at the higher slot wins;
- target selection: two equidistant targets, the lower entity ID at the higher slot is the one hit;
- a released slot in a stale index is never targeted and never charged for.

`brain/carcassSensors.test.ts` did **not** have this problem: its tie-break test already runs both
arrangements and asserts they mirror each other. That is the standard the combat tests now meet.

## 4. Strengthened: snapshot/restore during active combat

The shipped suite saved at one tick (250) and resumed. One tick can be lucky: combat and carrion
state changes shape from tick to tick — a cooldown counting down, a claim filed, a carcass created
by phase 13, a slot returned to the free list by phase 9 or phase 15 — so the tick a save lands on
decides which of those a naive restore would drop.

Added a test that saves at **every tick of a 24-tick window** in which kills, feeding and decay are
all happening, and resumes each save to a common horizon comparing the hash at **every** tick. This
is the method ADR 0007 used for reproduction, applied to the state Milestone 5 introduced. It
passes, which is a real result about `CarcassStore`'s serialized free list: reconstructing it by
scanning for inactive slots instead of restoring it verbatim would have failed here.

## 5. Documentation defect (P3, fixed)

`findCarcassInMouthRange` claimed in its doc comment to read "the POST-movement index, because
feeding resolves after movement". It reads `ctx.carcassIndex`, which is built in phase 2 alongside
`spatialPre`, and there is no post-movement carcass index. The result is correct — a carcass never
moves, and the eater's own position is read live — but the comment states a false premise inside the
one file whose correctness argument is entirely about which index is read when. Corrected to
describe the single carcass index and why one is enough.

## 6. Risks examined and found clean

Everything below was checked and no defect was found. Recorded so the next review knows what was
already covered and does not have to re-derive it.

| Risk (review brief)                               | Finding                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-attacker advantage                          | None. Phase 10 only files claims; an attacker's energy payment cannot affect another's eligibility, and target choice does not read other attackers.                                                                                                                                           |
| Killing while iterating claims / non-simultaneous | None. `markDeath` sets a pending flag only; `alive` is cleared in phase 13. Verified by a mutual kill in which **both** sides are credited.                                                                                                                                                    |
| Attackers acting when ineligible                  | None. Every earlier phase of the tick has finished with energy at a settled non-negative value (feeding in phase 9 only adds; metabolism, growth and reproduction all run later), and each attacker pays only its own cost, so one attacker's spending can never change another's eligibility. |
| Targeting dead/invalid entities                   | None. `findContactTarget` filters `alive !== 1`; verified against a deliberately stale index.                                                                                                                                                                                                  |
| Slot/entity-ID confusion                          | None found. Attribution stores both; the comparison is on ID, the credit is applied by slot, and the two are written together.                                                                                                                                                                 |
| Attack cooldown in snapshot/hash                  | Present in both — `OrganismStore.hashInto` and `organismSnapshot`, together with `kills`, `meatEnergyEaten` and `lastDamageQ`.                                                                                                                                                                 |
| Damage/armor arithmetic                           | `qmul` is float-multiply-then-truncate, so no 32-bit intermediate exists. `maxArmorDamageReductionQ < Q` is enforced, so full armor mitigates but never grants immunity.                                                                                                                       |
| Attack energy cost consistency                    | Paid exactly when a target is in contact; an out-of-range swing costs nothing, on every attempt.                                                                                                                                                                                               |
| Impact bonus state                                | Reads `scratch.speedFractionQ`, written for every living organism in phase 5 of the same tick.                                                                                                                                                                                                 |
| Kill attribution order dependence                 | Order-independent: max damage, ties to minimum entity ID, both computed per attacker/target pair. Now pinned by a slot-hostile test (§3).                                                                                                                                                      |
| Duplicate / missing carcasses                     | One per death; `pendingDeath` is cleared before the body is built, so a repeated sweep is a no-op. A zero-meat body deliberately leaves nothing (documented at the call site).                                                                                                                 |
| Carcass energy from nowhere                       | The mass term is an ecological source by specification (docs/03 §23, ADR 0008 §2); the **energy** term is bounded at 25% and is the conservative direction. Behaviour matches the spec.                                                                                                        |
| Carcass feeding over-consumption                  | Impossible by construction: allocation is `min(demand, available)` shared proportionally, and the integer remainder is bounded by the claimant count. `consume` asserts rather than clamps.                                                                                                    |
| Diet trade-off / universal generalist             | `efficiency = floor + span × affinity²` with `herbAff + carnAff = Q` makes the **sum** of the two efficiencies minimal at the generalist and maximal at both specialists. There is no universally optimal genome.                                                                              |
| Carcass decay ordering                            | Ascending slot, release inside the loop is safe because nothing creates a carcass during phase 15 and the bound is the high-water mark.                                                                                                                                                        |
| Free-list leaks / nondeterministic reuse          | LIFO, serialized verbatim, `liveCount + freeCount == slotHighWater` swept by the soak. Verified across restores.                                                                                                                                                                               |
| Carcass sensors bypassing perception              | Vision range and field of view only, same tie-breaks as the creature sensor. No smell.                                                                                                                                                                                                         |
| O(N²) searches                                    | Both carrion queries and the contact query go through a `SpatialGrid`; both carrion queries return immediately when the world holds no carcass.                                                                                                                                                |
| New authoritative state omitted from hash         | `CarcassStore.hashInto` covers every field the class declares, arrays and counters alike, plus the slot bookkeeping.                                                                                                                                                                           |
| Snapshot changing the RNG stream                  | `fromSnapshot` restores the PRNG state after construction, and neither organism nor carcass restore draws from it. Confirmed by identical continuations from 24 consecutive save points.                                                                                                       |
| Map/Set in authoritative logic                    | `OrganismStore#slotByEntityId` and the free-list validator's `Set` are used only for membership (`get`/`set`/`has`/`delete`); neither is iterated, so insertion order cannot leak into state.                                                                                                  |
| Per-tick allocation                               | None added. Every new query writes into a module-level result object, and the claim chains reuse scratch buffers.                                                                                                                                                                              |
| Regression of M0–M4 guarantees                    | Golden fixture, both 100 000-tick soaks and the full suite reproduce (§7). The M5 soak change **added** a carcass invariant sweep and raised only the hang detector; no assertion was weakened.                                                                                                |

## 7. Verification

`pnpm verify` — typecheck, lint, the full Vitest suite and the web build — after all fixes. The six
golden fixture hashes, the config digest `2d2712ccf817a700` and both 100 000-tick soak hashes are
**unchanged and reproduced**, which is the check that the fixes touched no authoritative behaviour.

## 8. Carried forward, unchanged

The three calibration findings ADR 0008 §5 reported are **not** defects and were not patched. This
review confirms the reasoning:

1. **No meat eaten in 10 000 ticks of the reference world.** The docs/04 §20 policy is implemented
   verbatim and the founder lineage is herbivore-leaning. Input for **L07**.
2. **The carcass cap saturates.** Correct at the cap by specification — deterministic skip plus a
   hashed counter, never an eviction. Input for **L07**, alongside the ADR 0006 §7 population cap.
3. **`pnpm test` costs ~1 880 s**, dominated by the 100 000-tick soak. The lever remains scheduling
   the soak rather than shortening it (ADR 0006 §9, docs/07 §6).

The foundation-gate and Milestone 2.5 branches are still unmerged, and must be merged before
**J05 / Milestone 9** (ADR 0006 §0, ADR 0008 §0).
