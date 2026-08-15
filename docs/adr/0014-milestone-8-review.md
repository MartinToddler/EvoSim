# ADR 0014 — Milestone 8 Review: Species and History

Status: accepted · Date: 2026-08-14 · Reviews: ADR 0013 (tasks I01–I08, E06)

Versions: `ENGINE_VERSION` **unchanged at 0.6.0**, snapshot schema unchanged (7), protocol
unchanged (4). **Every golden hash unchanged and reproduced** — the one engine fix below is
unreachable from any config that could previously construct an engine, so no world that could
exist behaves differently.

## 0. Scope and method

Independent audit of the Milestone 8 implementation against the twenty-one-point brief: trait
normalization, clustering determinism, initialization, tie handling, order dependence, species
flicker, false splits, failure to split persistent populations, minimum populations, split
persistence, centroid stability, ID allocation, extinction, lineage cycles, parent species, event
duplication, event hysteresis, pending-split snapshot state, event-detector snapshot, state hash
coverage and replay equivalence — statically by tracing concrete values through the code, and
dynamically through the mandated fixtures (all eight already present: one cloud, two persistent
clouds, transient split, one outlier, extinction, lineage, snapshot during pending split, long
deterministic run) plus targeted repro scripts. `pnpm verify` was green before the review
(67 files, 884 tests) and green after it.

## 1. P1, fixed: a validator-accepted config crashed engine construction

`validateConfig` accepts `min == max` gene ranges (`orderedRange` checks `min <= max`) — the
legitimate "fix this trait" experiment where every organism shares one value. Milestone 8's
`buildTraitRanges` asserted `span > 0`, so such a config passed validation and then threw
`"trait dimension 0 has a non-positive range"` in the engine constructor. Reproduced with
`DEFAULT_CONFIG` plus `adultRadiusMaxPos = adultRadiusMinPos`.

Same defect class as ADR 0007 §2 (validator-accepted cooldown wrapped in storage) and ADR 0009 §1
(validator-accepted carcass meat overflowed its row): the validator and the engine disagreeing
about what a legal config is.

**Fix**: a zero span is a CONSTANT dimension. `buildTraitRanges` stores span 1 for it, so
`(value − min) · Q / span` is exactly 0 for every member — a trait that cannot vary contributes
exactly nothing to any distance, which is the correct clustering semantics, not just a crash
avoided. The assert now guards only negative spans (which the validator genuinely prevents).
Unreachable from `DEFAULT_CONFIG` and from any config that could previously construct, so no
golden hash moves and `ENGINE_VERSION` stays 0.6.0 — the ADR 0009 §1 precedent. Regression test:
the degenerate config constructs, and two organisms at opposite extremes of the frozen gene
normalize that dimension to identical 0.

## 2. P2, fixed: a zero-pass split candidate would be silently dropped by save/load

`SpeciesStore.capture()` encodes "has a candidate" as `candidatePasses > 0`; `restore()` decodes
the same. A candidate with `passes === 0` — impossible today, since candidates are created at one
pass and only incremented — would be silently discarded across save/load, delaying a split by one
analysis interval: exactly the continuous-vs-restored divergence Milestone 8 exists to prevent,
guarded by nothing but a convention living in two files. `capture()` now asserts `passes >= 1`,
so any future violation fails loudly at save time instead of silently at restore.

## 3. Audited and sound (the NOT-A-BUG traces)

- **Trait normalization**: each dimension's `[min, max]` matches the exact expression the
  phenotype writer stores — including the effective-speed and effective-turn floors computed with
  the same `qmul` truncation the phenotype uses, and the `>> 1` half-FOV bounds containing every
  intermediate lerp value. Numerators are non-negative (every phenotype value ≥ its floor by
  construction), so `Math.trunc` is `floor` and the band is exactly `[0, Q]`.
- **Clustering determinism and ties**: seeding is exactly docs/05 §7 (A = lowest entity ID; B =
  farthest-from-A, tie → lowest ID; A2 = farthest-from-B, tie → lowest ID; centroids init A2/B).
  `farthestMemberIndex` maintains a (max distance, min entityId) extremum whose tracking
  variables all update on the strictly-greater branch — correct and order-independent. The
  all-identical cloud degenerates to an empty cluster B and fails the evaluation, never splits.
- **Order dependence**: members are gathered in slot order, but every decision is an
  entityId-keyed extremum, a per-member comparison against centroids, or a commutative exact
  integer sum — no outcome depends on gathering order. Overflow margins: centroid sums ≤ 8192 ×
  4096 < 2³¹; ΣΔ² ≤ 15·Q² ≈ 2.5e8; threshold products ≈ 5e10, all exact in doubles.
- **Flicker / false splits / minimums / persistence**: assignments change only at a split;
  daughters restart candidate history and need ≥ 2×`minDaughterPopulation` members plus five
  fresh qualifying analyses; the reset-on-failure policy plus the A/B-swap continuity comparison
  (made unambiguous by the ADR 0013 §2 validator rule) prevent oscillation and drift-splits; the
  outlier partition dies on the minimum-daughter condition.
- **ID allocation / lineage**: dense monotonic species IDs, never reused; parents strictly
  precede children (enforced again at restore), so cycles are unrepresentable; the soak sweeps
  the population-matches-members and parent-precedes-child invariants every 997 ticks for
  100 000 ticks.
- **Extinction / parent species**: marked by death finalization at the exact emptying tick;
  a split parent is `split`, never `extinct`; ended records are permanent and immutable.
- **Event duplication / hysteresis**: per-type emission sites are single; FirstPredation is a
  hashed latch; carnivore badges are once-per-species with an adequate-observation floor that
  neither grows nor resets the streak on starvation intervals; boom/crash judge against a
  baseline that excludes the current sample and share one debounce; mass-extinction windows may
  not overlap a previous event (a second catastrophe becomes reportable after one full fresh
  window — hysteresis by design); cap events fire once per pressure episode.
- **Snapshot / hash coverage**: every mutable field of `SpeciesRecord` (including the carnivore
  detector fields and candidate centroids), the event log (with `nextEventId` and
  `droppedEventCount`) and all thirteen `EventDetectors` fields are hashed and serialized;
  restore cross-validates the registry against the restored population; the statistics series is
  serialized-not-hashed by documented design with byte-equality pinned continuous-vs-restored.
- **Replay equivalence**: `pnpm equivalence` — Worker-scheduled, headless and golden agree at
  tick 1000 through two species analyses and ten statistics samples; the pending-split fixture
  restores at three of five stability passes and splits on the identical tick with an
  entry-for-entry identical event log.

## 4. Observations carried, not changed

1. The A14 line's own full-suite run caught three integration misses (the predator/prey fixture
   casting organisms into unregistered species — flagged by the new `recordBirth` assertion doing
   its job — and two version-pin tests), fixed in `8ebe6b3` before deployment. Recorded here
   because the _first_ commit of the milestone did not include them; nothing to fix now.
2. The 100 000-tick soak still ends with one species (ADR 0013 §9) — the L07 calibration
   question stands.
3. `speciesPopulation`-style per-species scratch grows by doubling and is engine-lifetime
   bounded by total species count; acceptable, documented.
