# ADR 0007 — Milestone 4 review: reproduction and mutation

Status: accepted · Date: 2026-08-13 · Engine 0.4.0 (unchanged) · Review of tasks E01–E08

Independent review of `ecology/reproduction.ts` and `genetics/mutation.ts` against the ten risks in
the Milestone 4 review brief, plus the five mandated verifications. Two defects were found and
fixed. **Neither is a change in authoritative behaviour, so `ENGINE_VERSION` stays 0.4.0 and every
golden hash is unchanged** — all six state hashes in `goldenStateHashes.json` and the 100 000-tick
soak hash were reproduced from scratch during this review and match the committed values exactly.

## 0. What was verified, and how

The reference numbers in ADR 0006 §7 were re-derived rather than trusted. The reference world at
ticks 2 000 and 10 000 reproduces its population, births, deaths and generation counts exactly, and
`pnpm headless --seed 0xE0A12026 --ticks 10000` reproduces all six golden hashes.

| Mandated verification                     | Result                                                                                                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeated 100k same-seed hash comparison   | **0 mismatches.** Two independent 100 000-tick runs agree at ticks 0, 1, 10, 100, 1 000, 10 000, 25 000, 50 000, 75 000 and 100 000. Final hash `8f88a197654c098b`, equal to `soak.test.ts`'s golden.                                                |
| Save/load continuation                    | **0 mismatches** restoring at every tick of a 48-tick window and continuing 24 ticks each; also save/load at tick 50 000 continues to the same 100 000-tick hash as the uninterrupted run.                                                           |
| Mutation statistical sanity, large sample | 200 000 births: 1.361 genes and 8.375 weights changed per birth against 1.363 and 8.398 predicted by the partition; weight-delta sd 398.8 against 398.7 predicted by the two-class mixture; weight-delta mean 0.16 against a standard error of 0.31. |
| No-mutation config fixture                | Accepted by the validator; genome and brain byte-identical across 1 000 successive births; still spends exactly 416 classification draws.                                                                                                            |
| Forced-mutation config fixture            | Accepted at the `sum == Q` boundary; every gene and 399/400 weights change in one birth; 1 000 forced generations stay inside every bound; forced reset is uniform over the whole raw span (mean 32 755 against 32 767.5).                           |

## 1. Defect: `pnpm verify` failed on a wall clock, not on a hash

`vitest.config.ts` set `testTimeout: 300_000`, derived from a ~150 s measurement of the 10 000-tick
reference world. Two **mandated acceptance tests** exceeded it on the review machine and
`pnpm verify` exited 1 with `Error: Test timed out in 300000ms`:

| Test                                                                     | Observed   |
| ------------------------------------------------------------------------ | ---------- |
| `goldenFixture` — state hashes at ticks 0, 1, 10, 100, 1000, 10000       | 520 247 ms |
| `organismSimulation` — snapshot taken mid-run and resumed to tick 10 000 | 429 033 ms |

Everything else passed: 486 of 488 tests, and both failures were timeouts with no assertion
involved. The same computation costs **188 s** standalone (`pnpm headless --ticks 10000`), so the
gap is Vitest worker contention: the file competes with the 100 000-tick soak and the other
acceptance suites, a **2.3–2.8x** factor that no single measurement on one machine predicts.

This is the mistake docs/07 §8 names directly — "do not enforce arbitrary CI wall-clock on unknown
hardware; record benchmarks". A budget set at 2x one machine's measurement is a performance
assertion wearing a timeout's clothes, and it fails the milestone gate for a reason unrelated to
correctness.

Fixed by treating the budget as a hang detector:

- global `testTimeout` 300 s → **600 s**, which is 3x the heaviest test that still relies on the
  default;
- the two mandated 10 000-tick determinism tests get explicit inline budgets of **1 800 000 ms**,
  the value `soak.test.ts` already chose, stated next to the tick count they pay for;
- `environmentSoak.test.ts`'s 100 000-tick soak moves from 300 s to the same 1 800 000 ms. It passed,
  but it is the identical construction and 300 s is precisely the number that has now been shown to
  be too tight.

The measured costs are recorded in the config comment so the next person changing them has the
numbers rather than a guess.

## 2. Defect: a cooldown above 65 535 was accepted and then silently wrapped

`reproduction.reproductionCooldownTicks` was validated only as a non-negative integer, while the
counter it drives is a `Uint16Array` row of `OrganismStore`. A `Uint16Array` assignment does not
clamp, it **wraps**, so a configured cooldown of 70 000 was stored as 4 464 and the parent came off
cooldown 65 536 ticks early — reproducing roughly fifteen times more often than the configuration
said, with nothing anywhere reporting a problem.

Confirmed directly: `validateConfig` accepted 70 000, and one call to `resolveReproduction` left
`reproductionCooldown[slot] === 4464`.

`combat.attackCooldownTicks` has the identical shape against the `attackCooldown` row. That row is
not written until Milestone 5, but it already exists, so the bound is asserted now rather than left
as a trap for the milestone that starts using it.

Both fields are now checked against a named `UINT16_MAX`, which also replaces the two places that
spelled `65535` inline. This is the standard the validator already applied to every gene range and
to `plants.baseCapacityByBiome`; the two cooldowns were simply missed.

The fix only ever **rejects more** configurations. `DEFAULT_CONFIG` is unaffected, the config shape
is unchanged (so `CONFIG_SCHEMA_VERSION` stays 5), `hashConfig` is untouched, and no world hash
moves.

## 3. The other eight risks: no defect found

Each was checked in the code and then measured.

**Conservation of energy — exact, not merely bounded.** Phase 14 is the only thing that can move
energy during reproduction, so the population's total must fall by exactly the increase in
`birthEnergyDiscarded`. Measured across 400 simultaneous births spanning the whole
investment × size grid: Σenergy fell 1 517 965 and the discard counter rose 1 517 965. Equality, not
inequality. A new test asserts it, because the existing per-birth tests balance one birth at a time
and cannot catch an accumulation error — a discard credited to the wrong parent balances per birth
and not in aggregate.

**Mutation probability correctness — exact marginals.** `classifyGeneRoll` and `classifyWeightRoll`
were enumerated over all 4 096 possible rolls: 328 small / 20 large / 1 reset and 82 small / 4 large,
exactly the configured numerators. `nextQ()` returns `[0, Q)`, so each interval's width _is_ its
probability.

**PRNG coupling — the only consumers are founder spawn, child placement and mutation.** No other
engine code touches the generator (sensory noise is stateless hashing, world generation and the
environment update draw nothing), so nothing couples the stream to render cadence, query timing or
population inspection. The cap gate is checked before any draw, which is what keeps a full world
from shifting the stream of the organisms after it.

**Iteration-order effects — explicit and as blueprinted.** Reproduction walks parents in ascending
slot order, which is what docs/10 §15 prescribes; feeding remainders use ascending entity ID, which
is what docs/03 §21 prescribes. The two differ deliberately and both are documented at their call
site. No authoritative code iterates a `Map` or an object's keys. Below the cap the order changes
only which PRNG draws each child receives, which is uniform and confers no advantage.

**Population cap bias — reproduced, and correctly deferred.** ADR 0006 §7's finding stands and its
numbers re-derive exactly. The mechanism is right: rejection is deterministic, in ascending parent
slot order, counted in `capRejectedBirths`, with the parent keeping its energy and its cooldown and
no randomness consumed. That the reference world's carrying capacity sits far above the 8 192 cap on
half the seeds tried remains a **calibration** finding for task L07, not a reproduction defect, and
this review does not re-tune it: docs/08 §24 requires faithful defaults first and docs/07 §14
requires 10–30 seeds before a tuning conclusion.

**Mutation destroying brains — measured, and it does not.** Cosine similarity between a surviving
brain and the founder brain it descends from, swept along a 50 000-tick run of the 96x96 world:

| Tick   | Population | Max generation | Mean similarity | Worst individual | RMS drift | Weights on clamp |
| ------ | ---------- | -------------- | --------------- | ---------------- | --------- | ---------------- |
| 0      | 64         | 0              | 1.0000          | 1.0000           | 0.0       | 0.0000%          |
| 10 000 | 1 614      | 8              | 0.9764          | 0.9157           | 158.7     | 0.0002%          |
| 25 000 | 30         | 16             | 0.9467          | 0.9135           | 242.4     | 0.0000%          |
| 50 000 | 913        | 34             | 0.8732          | 0.8240           | 387.4     | 0.0008%          |

An unrelated 400-dimensional brain would score about 1/√400 = 0.05, so after 34 generations the
_worst_ surviving individual is still sixteen times the noise floor, and drift of 387 stored units
sits against a clamp of ±8 192 with essentially nothing pinned to it. Drift also grows as √generations
— 158.7, 242.4, 387.4 against generations 8, 16, 34 — which is the neutral random walk the configured
rate and sigma predict, so nothing is amplifying it. That is drift under selection, not erasure.

The guard now lives in `soak.test.ts`, where a 100 000-tick engine at generation 60+ already exists,
so the deepest available lineage is measured at no extra cost. Its bounds (mean similarity above 0.2,
under 5% of weights on the clamp) are deliberately loose: docs/07 §1 forbids asserting an
evolutionary story, so they separate "drifting" from "erased" and nothing finer.

**Accidental cloning without mutation — rare, and correct.** About 1 birth in 40 000 changes none of
its 416 loci. That is not a skipped mutation: it is exactly
`(1 - 349/4096)^16 × (1 - 86/4096)^400`, the per-locus probabilities docs/04 §18 specifies, and a
clone is a legitimate outcome of them. The new test pins the order of magnitude, so a genuinely
skipped mutation loop — which would push this toward 1 — fails loudly.

**Unsafe genome bounds — none reachable.** Genes are clamped to `[0, 65535]` and weights to the
configured symmetric bound on every write; the gene-range config fields are already checked against
Uint16 storage; and 200 000 sampled births plus 1 000 forced generations under maximal pressure
produced no out-of-range value. `geneDeltaRaw`'s worst-case product is ~6.6e12, three orders of
magnitude inside exact integer range.

**Child state initialization — complete.** All twenty per-slot fields are written by
`spawnOrganism`, and every scratch row metabolism later reads (`speedFractionQ`, `accelFractionQ`,
`inWater`, the feeding block, `pendingDeath`) is written unconditionally for every live slot earlier
in the same tick, so a newborn in a recycled slot cannot inherit its predecessor's transient state.
The 48-tick restore sweep is the empirical form of that argument: a restored engine starts with
zero-filled scratch and a continuous one does not, so any cross-tick scratch read would have shown
up as a hash mismatch.

**Snapshot completeness — nothing missing.** `nextEntityId`, the free list verbatim, `generation`,
`parentEntityId`, `reproductionCooldown`, `capRejectedBirths`, `birthEnergyDiscarded`,
`deathsByCause` and the PRNG state all round-trip; the 48-tick sweep checks each by name as well as
through the hash. The one theoretical gap — `restoreOrganisms` not clearing genome slots beyond the
restored high-water mark — is unreachable rather than merely harmless: `slotHighWater` starts at
`world.initialOrganisms` and never decreases, so a snapshot's used prefix can never be shorter than
the prefix the constructor just wrote.

## 4. Scope held

No reproduction or mutation rule changed, no constant was re-tuned, no golden hash moved, and
Milestone 5 was not started. ADR 0006 §0's outstanding recommendation is unchanged and still
outstanding: the Milestone 0–2 foundation-gate line is not merged into this line, and it must be
merged before Milestone 9.
