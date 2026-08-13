# TASKS — Claude Code Execution Checklist

Check only after code + tests + acceptance criteria pass.

## A Foundation
- [x] A01 pnpm workspace.
- [x] A02 Vite React TypeScript shell.
- [x] A03 engine/protocol/renderer/persistence/ui/shared packages.
- [x] A04 strict TS config.
- [x] A05 lint/format/Vitest.
- [x] A06 `pnpm verify` = typecheck + lint + test + build.
- [x] A07 versions/changelog.

## B Determinism core
- [x] B01 fixed-point helpers.
- [x] B02 angle/trig LUT.
- [x] B03 deterministic PRNG.
- [x] B04 PRNG golden vectors.
- [x] B05 engine fixed-step shell.
- [x] B06 canonical state hash.
- [x] B07 headless runner.
- [x] B08 deterministic hash fixture.

## C World/ecology
- [x] C01 typed SimulationConfig.
- [x] C02 deterministic value noise.
- [x] C03 elevation/sea/validity.
- [x] C04 moisture/temp/fertility.
- [x] C05 biomes.
- [x] C06 plant capacities.
- [x] C07 growth/gradient cache.
- [x] C08 founder spawn region.
- [x] C09 environment golden tests.

## D Organisms
- [x] D01 SoA organism store/free slots.
- [x] D02 gene arrays/mappings.
- [x] D03 growth/mass/energy.
- [x] D04 spatial hash.
- [x] D05 sensor vector.
- [x] D06 quantized NN.
- [x] D07 founder fixture.
- [x] D08 intents.
- [x] D09 movement/terrain/collision.
- [x] D10 plant claim resolution.
- [x] D11 basal/movement/thermal costs.
- [x] D12 starvation/healing/old age.
- [x] D13 death finalization.

Milestone 3 review gate: **PASS** (engine 0.3.1, ADR 0005). Deterministic 10k reproduced twice and
against the golden fixture; snapshot/resume verified at ticks 1, 2497, 2500 and 6050; founder
viability confirmed across six seeds. Three defects found and fixed: coincident-body separation
ordered by slot instead of entity ID, `allocateSlot` losing a slot if entity IDs were exhausted,
and snapshot restore trusting a malformed free list. Golden hashes unchanged.

## E Evolution
- [x] E01 reproduction conditions.
- [x] E02 child energy/spawn.
- [x] E03 ecological mutation.
- [x] E04 brain mutation.
- [x] E05 generation/parent IDs.
- [ ] E06 population cap event — deterministic rejection and diagnostics counters done; the
      `PopulationCapReached` timeline event needs the Milestone 8 `EventStore`.
- [x] E07 100k deterministic soak.
- [x] E08 parameter sweep harness.

Milestone 4 gate: **PASS WITH NOTES** (engine 0.4.0, config schema 5, snapshot schema 5,
ADR 0006). Asexual reproduction, ecological and brain mutation, generation/parent lineage,
deterministic cap rejection and the 100k evolutionary soak are implemented and tested; all golden
hashes regenerated.

Two notes carried forward:

1. **The world's carrying capacity is far above the 8 192 safety cap** (ADR 0006 §7). Six seeds at
   10 000 ticks: all survive, **three pinned at the cap** with 5.5–6.1M refused births, and their
   trait diversity roughly half the uncapped seeds' — the cap is filtering by storage order instead
   of ecology. The defaults were implemented faithfully and deliberately not tuned: docs/08 §24
   requires that order, and docs/07 §14 requires 10–30 seeds before a tuning conclusion. This is
   input for **L07** (10+ seed calibration), and `pnpm sweep` is the harness. docs/01 §12 makes
   "population does not normally slam into engine cap" an MVP release gate, so L07 is now on the
   critical path.
2. **The Milestone 0–2 foundation-gate branch is not merged into this line** (ADR 0006 §0). It fixes
   six real defects that Milestone 4 does not depend on, but the merge must happen before **J05 /
   Milestone 9** (terrain raise/lower), because that is when its `fromSnapshot` fix stops being
   merely an optimization.

Milestone 4 review gate: **PASS** (engine 0.4.0 unchanged, ADR 0007). Reproduction and mutation were
reviewed against conservation of energy, mutation probability correctness, PRNG coupling,
iteration-order effects, cap bias, brain degradation, accidental cloning, genome bounds, child
initialization and snapshot completeness. **All golden hashes were reproduced from scratch and are
unchanged** — the six fixture hashes and the 100 000-tick soak hash `8f88a197654c098b`.

Verifications: repeated 100k same-seed comparison **0 mismatches** across ten checkpoints; save/load
restored at **every tick** of a 48-tick window and continued 24 ticks each, **0 mismatches**, plus
save/load at tick 50 000 continuing to the identical 100 000-tick hash; mutation statistics over
200 000 births matching the partition's predictions to within 0.3%; no-mutation and forced-mutation
config fixtures both valid and behaving exactly as specified.

Two defects found and fixed, neither an authoritative behaviour change:

1. **`pnpm verify` failed on a wall clock, not on a hash.** `testTimeout` was 300 s, set from a
   ~150 s measurement, but Vitest's parallel workers make the 10 000-tick reference-world tests cost
   429–520 s inside the suite against 188 s standalone. Two mandated acceptance tests timed out
   (486 of 488 tests passed, both failures timeouts with no assertion involved). docs/07 §8 forbids
   exactly this — an arbitrary CI wall clock on unknown hardware — so the budgets are now hang
   detectors: global 600 s, and 1 800 000 ms inline on the long determinism tests, matching the soaks.
2. **A cooldown above 65 535 was accepted and then silently wrapped.**
   `reproduction.reproductionCooldownTicks` was validated only as a non-negative integer while its
   counter is a `Uint16Array` row, so 70 000 was stored as 4 464 and the parent reproduced ~15x more
   often than configured. Both it and `combat.attackCooldownTicks` are now bounded by the storage
   width, as every gene range already was.

E06 stays open for the same reason as before: the `PopulationCapReached` timeline event needs the
Milestone 8 `EventStore`. Both ADR 0006 notes above are carried forward unchanged.

## F Predation
- [ ] F01 carcass store/decay.
- [ ] F02 carcass sensors/claims.
- [ ] F03 diet trade-off.
- [ ] F04 attack claims.
- [ ] F05 simultaneous damage.
- [ ] F06 armor/costs.
- [ ] F07 kill attribution.
- [ ] F08 predator/prey fixture.

## G Worker/renderer
- [ ] G01 protocol unions.
- [ ] G02 Worker host/scheduler.
- [ ] G03 MAX yielding.
- [ ] G04 render snapshot.
- [ ] G05 Pixi terrain.
- [ ] G06 organism ParticleContainer.
- [ ] G07 LOD/detail layer.
- [ ] G08 camera.
- [ ] G09 selection/query.
- [ ] G10 debug overlay.

## H UI/analytics
- [ ] H01 app shell/top bar.
- [ ] H02 time controls/actual TPS.
- [ ] H03 organism inspector.
- [ ] H04 global stats/charts.
- [ ] H05 heatmaps.
- [ ] H06 responsive mobile layout.

## I Species/history
- [ ] I01 species registry.
- [ ] I02 trait vector/distance.
- [ ] I03 deterministic 2-means.
- [ ] I04 stability candidate.
- [ ] I05 split/extinction.
- [ ] I06 events.
- [ ] I07 tree UI.
- [ ] I08 species inspector.

## J Player tools
- [ ] J01 immutable command log.
- [ ] J02 stroke resampling.
- [ ] J03 global/local temperature.
- [ ] J04 moisture/fertility.
- [ ] J05 terrain raise/lower.
- [ ] J06 biomass.
- [ ] J07 meteor.
- [ ] J08 timeline integration.
- [ ] J09 optional translocation.

## K Persistence/replay
- [ ] K01 IndexedDB schema.
- [ ] K02 manifests.
- [ ] K03 snapshot serializer/checksum.
- [ ] K04 manual save/load.
- [ ] K05 autosave.
- [ ] K06 deterministic save/reload test.
- [ ] K07 rewind reconstruction.
- [ ] K08 historical preview.
- [ ] K09 return present.
- [ ] K10 branch.
- [ ] K11 branch deterministic test.

## L Quality/performance
- [ ] L01 benchmark CLI.
- [ ] L02 phase timing.
- [ ] L03 memory diagnostics.
- [ ] L04 render performance pass.
- [ ] L05 time-series downsampling.
- [ ] L06 1M soak.
- [ ] L07 10+ seed calibration.
- [ ] L08 Playwright flows.
- [ ] L09 Chromium/Firefox/WebKit validation.

## M PWA/mobile
- [ ] M01 installable/offline app shell.
- [ ] M02 touch/safe areas.
- [ ] M03 lifecycle pause/resume.
- [ ] M04 Capacitor integration.
- [ ] M05 iOS device test.
- [ ] M06 Android device test.
- [ ] M07 save/load validation.
