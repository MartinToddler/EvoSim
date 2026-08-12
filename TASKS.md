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
- [ ] C01 typed SimulationConfig. <!-- The type exists and is fully validated (ADR 0002 §6),
      but this box belongs to the Milestone 2 block and stays open until the environment work
      that consumes the config lands. -->
- [ ] C02 deterministic value noise.
- [ ] C03 elevation/sea/validity.
- [ ] C04 moisture/temp/fertility.
- [ ] C05 biomes.
- [ ] C06 plant capacities.
- [ ] C07 growth/gradient cache.
- [ ] C08 founder spawn region.
- [ ] C09 environment golden tests.

## D Organisms
- [ ] D01 SoA organism store/free slots.
- [ ] D02 gene arrays/mappings.
- [ ] D03 growth/mass/energy.
- [ ] D04 spatial hash.
- [ ] D05 sensor vector.
- [ ] D06 quantized NN.
- [ ] D07 founder fixture.
- [ ] D08 intents.
- [ ] D09 movement/terrain/collision.
- [ ] D10 plant claim resolution.
- [ ] D11 basal/movement/thermal costs.
- [ ] D12 starvation/healing/old age.
- [ ] D13 death finalization.

## E Evolution
- [ ] E01 reproduction conditions.
- [ ] E02 child energy/spawn.
- [ ] E03 ecological mutation.
- [ ] E04 brain mutation.
- [ ] E05 generation/parent IDs.
- [ ] E06 population cap event.
- [ ] E07 100k deterministic soak.
- [ ] E08 parameter sweep harness.

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
