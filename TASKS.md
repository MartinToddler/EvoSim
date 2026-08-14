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
- [x] F01 carcass store/decay.
- [x] F02 carcass sensors/claims.
- [x] F03 diet trade-off.
- [x] F04 attack claims.
- [x] F05 simultaneous damage.
- [x] F06 armor/costs.
- [x] F07 kill attribution.
- [x] F08 predator/prey fixture.

Milestone 5 gate: **PASS WITH NOTES** (engine 0.5.0, config schema 6, snapshot schema 6, ADR 0008).
Phases 10, 11 and 15 of the tick order now run. Carcasses, temperature-driven decay, carcass sensing
and feeding, the diet trade-off, attack claims with contact/energy/cooldown validation, simultaneous
damage, armor, impact bonus and kill attribution are implemented and tested (78 new tests). Every
golden hash regenerated. There is no `Predator` type and no rule that reads one: a hunter is an
attack gene, an attack output, a carnivore diet gene and a controller that steers at what it senses.

Verified before starting: the Milestone 3/4 tip `734b50b` reproduced all six golden fixture hashes in
a pristine worktree, so the previous milestone's claims were checked rather than trusted.

Three notes carried forward:

1. **No meat was eaten in 10 000 ticks of the reference world** (ADR 0008 §5a). The founder lineage
   is herbivore-leaning (mean diet −0.597 from a −0.600 start), and the docs/04 §20 policy only sends
   an organism to a carcass when meat digests at least as well as plants. The mechanism is proven by
   the predator/prey fixture and by a controlled diet experiment; whether carnivory is reachable on
   the default constants at a realistic horizon is a calibration question for **L07**. docs/07 §12
   lists "carnivory impossible" as a failure mode to monitor, so this is on the watch list rather
   than patched.
2. **The carcass cap saturates**: 4 096 live and 4 751 skipped by tick 10 000 (ADR 0008 §5b). At the
   documented decay rate a carcass survives ~8 000 ticks, so a world losing ~1 organism per tick
   accumulates toward twice `limits.maxCarcasses`. Behaviour at the cap is correct by specification
   (deterministic skip + hashed diagnostics counter), but it suppresses the carrion supply this
   milestone creates. Input for **L07** together with the ADR 0006 §7 population-cap finding — the two
   share a cause.
3. **The foundation-gate and Milestone 2.5 branches are still not merged into this line**
   (ADR 0006 §0, ADR 0008 §0). Milestone 5 does not depend on any of their fixes, but the merge must
   happen before **J05 / Milestone 9** (terrain raise/lower).
4. **`pnpm test` now costs ~1 880 s wall, against ~940 s at 0.4.0**, dominated by the 100 000-tick
   soak: carrion sensing scales with population × carcass density and the soak world packs up to
   4 096 carcasses into 2 304 spatial cells (ADR 0008 §7). The soak's inline hang detector was raised
   from 1 800 000 ms to 5 400 000 ms with the measurements recorded next to it — it is a hang
   detector, not a wall-clock assertion (docs/07 §8). No assertion was weakened, and the soak gained
   a carcass invariant sweep. ADR 0006 §9's note is now more pressing: if `pnpm verify` becomes a
   per-commit gate, the lever is scheduling the soak rather than shortening it, since docs/07 §6 asks
   for 100 000 ticks routinely.

Milestone 5 review gate: **PASS** (engine 0.5.0 unchanged, ADR 0009). Carrion, combat and the diet
trade-off were reviewed against thirty risks and eighteen mandated scenarios. **All golden hashes are
unchanged and reproduced** — the six fixture checkpoints, the config digest `2d2712ccf817a700` and
both 100 000-tick soak hashes.

Verifications: two independently built predation worlds agree on the state hash at **every one of
600 ticks** through real kills, carcasses and scavenging; save/load restored at **every tick** of a
24-tick combat window and continued to a common horizon, **0 mismatches**; 800 ticks with a per-tick
check of meat conservation, entity-ID uniqueness, carcass validity and energy/health bounds; 1v1,
2v1, 1v2, mutual lethal and multi-contributor combat, armor, cooldown spacing, attack cost,
out-of-range swings, dead targets, carcass lifecycle and multi-feeder conservation all verified
against hand-built states.

One defect found and fixed, plus two gaps:

1. **Carcass meat above 2³²−1 silently truncated into its storage row.** `remainingMeat` is a
   `Uint32Array` while `totalMeatCreated` is a plain safe integer, and `organism.carcass.meatPerMass`
   had no upper bound — so a config the validator *accepted* stored a 6 075 000 948-unit body as
   1 780 033 652 and conjured 4 294 967 296 units into the accounting. That breaks
   `created == eaten + decayed + Σ remaining`, the invariant ADR 0008 §2 names as this milestone's
   replacement for energy conservation, and it breaks it in a way none of its own tests could see,
   because they all read the counter. Same class as ADR 0007 §2's Uint16 cooldown wrap, and fixed the
   same way: the validator now rejects any config whose largest possible body would overflow the row,
   and the store asserts the bound at the storage boundary. Not reachable from `DEFAULT_CONFIG`, so
   no hash moved.
2. **The kill-attribution tie-break test could not have failed.** It spawned the two attackers in
   entity-ID order, which is also slot order until something dies — so it would have passed against
   an implementation that simply kept the first attacker it iterated over, the exact slot-order bias
   the phase split exists to prevent. Target selection had no tie-break test at all. The
   implementation is correct; three tests were added that hand a freed slot to the *later-born*
   organism so the two orders disagree.
3. **Snapshot coverage saved at one tick.** Now saves at **every tick** of a window in which kills,
   feeding and decay are all happening — the method ADR 0007 used for reproduction.

One limit is documented rather than fixed (ADR 0009 §2): accumulated combat damage could wrap
`Int32` at roughly `baseAttackDamageQ > 49 × Q` with ~8 000 bodies in one pile. Since
`baseAttackDamageQ = Q` already one-shots any organism, that config is meaningless before the
arithmetic fails, and the only fix would be an invented ceiling on a field docs/08 leaves open.

All four Milestone 5 notes above are carried forward unchanged; this review confirms that findings
1–3 are calibration questions for **L07**, not defects.

## G Worker/renderer
- [x] G01 protocol unions.
- [x] G02 Worker host/scheduler.
- [x] G03 MAX yielding.
- [x] G04 render snapshot.
- [x] G05 Pixi terrain.
- [x] G06 organism ParticleContainer.
- [x] G07 LOD/detail layer.
- [x] G08 camera.
- [x] G09 selection/query.
- [x] G10 debug overlay.

Milestone 6 gate: **PASS** (engine 0.5.0 unchanged, protocol 1 → 2, host runtime schema 1 → 2,
ADR 0010). Deployed and verified at **https://martintoddler.github.io/EvoSim/**. The simulation runs in a dedicated Worker, render state crosses as packed
transferable buffers, and a PixiJS renderer draws terrain, organisms, carcasses, a camera, selection
and a development overlay. **Every golden hash is unchanged and reproduced** — this milestone adds
projection and hosting, not behaviour, which is what CLAUDE.md requires of a UI-only change.

Determinism acceptance: a world driven through the Worker's scheduler and the same world stepped
headlessly in Node reach the same canonical hash. Verified twice — a straightforward 240-tick run at
20×, and a deliberately erratic one (five speed changes, three pauses, a MAX burst, snapshots and
entity queries interleaved) topped up through the protocol to tick 2 000, identical to 2 000
uninterrupted steps. Separately, a world observed between every tick and a world never observed
agree after 80 ticks, so producing a picture cannot perturb the thing pictured.

Browser smoke test (Chromium, seed `0xE0A12026`, 1440×900): world generates and paints, 20× holds
401 TPS against a 400 target, pause freezes the tick exactly, wheel/drag/pinch and click-selection
work, the inspector returns live authoritative detail, and MAX reaches 75–92 TPS with ~1 280
organisms on this container. Zero console errors, zero page errors.

Three notes carried forward:

1. **The deployment needed two repository settings that no workflow token can change.** Enabling
   Pages requires repository-administration scope, which `GITHUB_TOKEN` cannot hold, so
   `configure-pages` failed with "Resource not accessible by integration" until Pages was switched on
   by hand. Then the `deploy` job was rejected in one second with no runner: enabling Pages with the
   GitHub Actions source creates a `github-pages` environment restricted to the **default branch**,
   and this milestone deploys from a feature branch. Both are now resolved — the repository is public
   (which also makes Pages free and Actions minutes unlimited) and the environment has no branch
   restriction. Recorded because the failure modes are unobvious: the second one produces an empty
   log and looks like an infrastructure glitch rather than a policy denial. `main` now carries the
   full Milestone 0-6 history as a fast-forward and is the sole source of the published site.
   **Outstanding: the repository's default branch is still `claude/milestone-0-1-setup-g7huou`**, a
   feature branch stopped at Milestone 2, so the repo front page and the cross-platform
   `determinism` matrix both look at Milestone 2 until it is pointed at `main`.
2. **Playwright is still not wired into the repository (L08).** The browser verification above was
   run ad-hoc against a real Chromium. CLAUDE.md's toolchain policy says to add Playwright once the
   first interactive vertical slice exists, which is now true, but the suite itself is section L.
3. **CI's `verify` job had been cancelling at its 20-minute timeout since Milestone 4** (runs 8-13),
   so no push since the evolution milestone was actually verified by CI, and the cross-platform
   `determinism` matrix never ran at all because `needs: verify` gated it behind the cancelled job.
   Both budgets are raised to 60 minutes and documented as hang detectors, and the `determinism`
   matrix is gated to the default branch and manual runs — three engine suites with macOS at 10x
   billed minutes is ~200 minutes per push, which raising the timeout would have enabled everywhere
   at once. This is a symptom of the suite cost that ADR 0006 §9 and ADR 0008 §7 both flagged; the
   real fix is scheduling the soaks separately, which stays open.
4. **The foundation-gate and Milestone 2.5 branches are still not merged** (ADR 0006 §0, ADR 0008 §0,
   ADR 0010 §0). Milestone 6 does not depend on either. The renderer's biome palette deliberately
   reuses the Milestone 2.5 colours verbatim so the eventual merge is textual rather than visual.
   The deadline is unchanged: before **J05 / Milestone 9**.

## H UI/analytics
- [x] H01 app shell/top bar.
- [x] H02 time controls/actual TPS.
- [x] H03 organism inspector.
- [x] H04 global stats/charts.
- [x] H05 heatmaps.
- [x] H06 responsive mobile layout.

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
