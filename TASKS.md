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
- [x] E06 population cap event — deterministic rejection and diagnostics counters since M4; the
      `PopulationCapReached` timeline event landed with the Milestone 8 `EventStore` (one event
      per pressure episode, ADR 0013 §4).
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

Milestone 7 review gate: **PASS** (engine 0.5.0 unchanged, protocol 3 unchanged, ADR 0012). The
observation UI was reviewed against the eighteen-point brief — placeholder honesty, the React
boundary, telemetry cadence, chart memory bounds, stale queries, entity death, follow, slot vs
entity ID, pause/play, rapid speed switching, layer purity, query purity, resize, mobile layout,
gestures, listener/chart leaks, Pixi lifetime, accessibility — statically, through the fake-driven
session tests, and in a scripted headless-Chromium pass (25/25 checks, zero console/page errors).
**Every golden hash is untouched**: all fixes are presentation-side.

Four P2 defects found and fixed, plus three P3 polish items:

1. **A third finger during a pinch fired a click selection** — `#onPointerDown` treated only
   exactly-two pointers as a pinch, so a steadying finger became a zero-travel drag whose lift
   read as a tap and silently retargeted selection, follow and the inspector. Any `>= 2` pointers
   are now a pinch, and no pinch finger can end as a click.
2. **Touch dead ends** — a pinch ending with one finger down left that finger inert (now it
   continues as a pan that can never click), and `.chart-plot { touch-action: none }` made the
   mobile stats sheet unscrollable wherever a chart was under the finger (now `pan-y`).
3. **The one-sheet rule did not survive becoming narrow** — rotating/shrinking with both panels
   open stacked two bottom sheets (browser-reproduced). Panel state is one object now, settled in
   the media-query subscription: entering narrow keeps stats and closes layers.
4. P3: speed tooltips now derive from `hostRuntime.targetTicksPerSecond1x` instead of hardcoding
   the defaults; the layer radios expose `aria-checked` alone (`aria-pressed` contradicted the
   radio role); the seed-copy confirmation timer is cleared on re-click and unmount.

## I Species/history
- [x] I01 species registry.
- [x] I02 trait vector/distance.
- [x] I03 deterministic 2-means.
- [x] I04 stability candidate.
- [x] I05 split/extinction.
- [x] I06 events.
- [x] I07 tree UI.
- [x] I08 species inspector.

Milestone 8 gate: **PASS** (engine 0.5.0 → 0.6.0, snapshot schema 7, protocol 4, ADR 0013).
Phases 16 (species analysis) and 17 (statistics/event detection) now run. The registry, the
versioned fifteen-dimension trait vector, deterministic seeded 2-means with five-interval
stability, extinction-at-the-death-tick, the bounded event log with eight live detectors, the
tiered statistics store, protocol 4 and the species panel / Tree of Life / history timeline are
implemented and tested (61 new tests; 13 mandated fixtures all present). **Every golden hash
regenerated** — the canonical stream gained the species registry, event log and detector state —
while the organism trajectory reproduces 0.5.0 exactly (same 10k population/generation/diet).
Snapshot schema 7 restores a mid-candidate world to an identical future: split on the same tick,
event log equal entry for entry, statistics byte-identical.

Two notes carried forward:

1. **100 000 ticks of real evolution end with ONE species** (ADR 0013 §9). The founder lineage's
   evolved diversity is a continuous cloud, and the docs/05 §7 detector exists precisely to
   refuse to split clouds — the synthetic fixtures prove real bimodality splits after exactly
   five stable analyses. Whether default constants let bimodality EMERGE at realistic horizons
   joins the L07 calibration questions (docs/07 §12 lists "species never splitting" as a failure
   mode to monitor there).
2. **"Focus members" from the docs/06 §12 species-inspector list is deferred** — it needs a
   member-position query the protocol does not carry; every other listed field shipped.

Milestone 8 review gate: **PASS** (engine 0.6.0 unchanged, ADR 0014). The implementation was
audited against the twenty-one-point brief — normalization, clustering determinism,
initialization, ties, order dependence, flicker, false splits, failure-to-split, minimum
populations, split persistence, centroid stability, IDs, extinction, lineage cycles, parent
species, event duplication, event hysteresis, pending-split and detector snapshots, hash coverage,
replay equivalence — by tracing concrete values and by repro scripts; all eight mandated fixtures
were already present and honest. **Every golden hash unchanged and reproduced.** Two defects found
and fixed, neither reachable from a previously-constructible world: a validator-accepted
`min == max` gene range crashed engine construction (now a constant dimension contributing zero
distance — the ADR 0007 §2 / ADR 0009 §1 class), and `SpeciesStore.capture()` would silently drop
a hypothetical zero-pass split candidate (now asserted loudly at save time).

## J Player tools
- [x] J01 immutable command log.
- [x] J02 stroke resampling.
- [x] J03 global/local temperature.
- [x] J04 moisture/fertility.
- [x] J05 terrain raise/lower.
- [x] J06 biomass.
- [x] J07 meteor.
- [x] J08 timeline integration.
- [ ] J09 optional translocation — deliberately not built: docs/01 §4 and docs/02 §15 both label
      it "late-MVP if schedule permits", and `TRANSLOCATE_ORGANISMS` is the one command whose
      payload the docs never specify. It stays open as the optional task it is.

Milestone 9 gate: **PASS** (engine 0.6.0 → 0.7.0, snapshot schema 8, config schema 7, protocol 5,
ADR 0015). Phase 0 (applyCommands) now runs. Player input is canonical commands only: immutable,
versioned (`COMMAND_SCHEMA_VERSION` 1), engine-stamped `(id, tick, sequence)` identity, validated
with deterministic rejection (past tick / malformed / out of bounds), `(tick, sequence)`-ordered,
hashed and serialized with an application cursor so a restored world neither re-applies nor skips
a command. Brush strokes canonicalize in the protocol package (fixed world-distance resampling +
whole-LU quantization) so pointer event rate never reaches history — the same stroke at 2, 17 and
500 pointer events is the same command. Every documented tool shipped: global temperature offset,
warm/cool, wet/dry, fertility, terrain raise/lower (with real flooding/draining via the
deterministic biome/capacity/passability region recompute), biomass add/remove (with the
docs/03 §27 bounded transient overfill), and the meteor (radial organism damage with a lethal
core, biomass loss, crater, scorched soil, Major event). Each applied command appends exactly one
PlayerIntervention event; the timeline names the tool. The golden fixture now RUNS a nine-command
log covering every kind — every applier is inside the golden regression net. 96 new tests.

**The pre-J05 merge mandate is closed** (ADR 0006 §0 → ADR 0013 §10): the foundation-gate and
Milestone 2.5 branches were reconciled semantically rather than textually merged — every
foundation-gate fix is now in this line (exact config shape, geometry bounds, snapshot value
validation, restore-without-regeneration through a forge-proof channel, the hashed founder
region, the sealed environment store, the `__proto__`-safe clone, dead noise salts removed), and
the M2.5 debug visualizer is recorded as superseded by the M6 renderer + M7 layer views it was
reused into. Details and per-fix disposition in ADR 0015 §0.

## K Persistence/replay
- [x] K01 IndexedDB schema.
- [x] K02 manifests.
- [x] K03 snapshot serializer/checksum.
- [x] K04 manual save/load.
- [x] K05 autosave.
- [x] K06 deterministic save/reload test (independently re-verified, ADR 0017).
- [x] K07 rewind reconstruction.
- [x] K08 historical preview.
- [x] K09 return present.
- [x] K10 branch.
- [x] K11 branch deterministic test.

Milestone 11 gate: **PASS** (protocol 6 → 7, engine 0.7.0 and every golden hash unchanged, ADR
0018). Any earlier tick is reconstructed from the newest save at or before it plus the command log
plus deterministic forward simulation, previewed read-only in a second engine, and left again by a
mode switch rather than a reload. A branch is an independent world inheriting its parent's history
only through the branch point: control to 10 000 ticks equals a branch taken at 5 000 with no new
commands, and equals one taken at 6 234 that needed save + replay to reconstruct — on the populated
world, with organisms, species and events. A branch-only command diverges the branch and leaves the
original untouched. A preview cannot reach the present: it is a second engine, the host refuses
interventions and saves while it is open, and a superseded rewind is cancelled on both sides.
Limitation recorded in ADR 0018 §7: a world must have a save at or before a tick to be rewound
there.

## Recovered work (found by branch audit, Milestone 11)

- [x] Milestone 2.5 world generator — built, reviewed, never merged; restored as `?view=generator`
      (ADR 0020).
- [x] Milestone 6 architecture review — an entire independent review, never merged; its five fixes
      and adversarial suite restored (ADR 0019).

Both were found by comparing every remote branch against the trunk. The foundation-gate branch was
checked too and is genuinely reconciled (ADR 0015 §0), so nothing else is outstanding.

## L Quality/performance
- [x] L01 benchmark CLI — `pnpm benchmark:engine`, every field docs/07 §9 asks for.
- [x] L02 phase timing — engine hooks and host timing existed since M6; M12 adds the Node profiler
      in the benchmark and the browser performance HUD that finally displays `phaseMillis`.
- [x] L03 memory diagnostics — `estimateEngineMemory` (twelve engine categories),
      `RenderBufferPool.allocatedBytes`, chart retention, all surfaced in the HUD.
- [x] L04 render performance pass — measured in a real browser; see the finding below.
- [x] L05 time-series downsampling — already delivered on both sides (engine `StatisticsStore`
      tiers, UI `StatsHistory`); M12 adds the assertions that tie retention to the memory watch.
- [x] L06 1M soak — `pnpm soak:long`, sharing one world and one invariant sweep with the
      100 000-tick Vitest soak. **Run to completion**: 1 000 000 ticks, 2 013 sweeps all clean,
      192 376 births / 190 904 deaths fully attributed, 328 generations, population 25–3 223,
      snapshot round trip exact and continuation identical, memory flat at 9.35 MiB, and the hash at
      tick 100 000 is the Vitest soak's golden `a7e2b5e223c8657a`. Final hash `c0f11ebb61152ef3`.
- [x] L07 10+ seed calibration — twelve seeds at 10 000 ticks; findings below.
- [x] L08 Playwright flows — all ten docs/07 PART E scenarios.
- [x] L09 Chromium/Firefox/WebKit validation — matrix built by probing installed browsers.

Milestone 12 gate: **PASS** (engine 0.7.0 and every golden hash unchanged, protocol 7 → 8,
ADR 0021). This milestone measures; it changes no simulation rule and moves no authoritative
constant. Protocol 8 adds `TelemetryDto.memory` and `WorldDisplayDto.tickPhaseLabels`, both
diagnostics.

**Performance.** The hotspot is **sensing, at 52% of the tick, in both Node and a browser** —
5 000-organism benchmark on the delivery container: mean tick 61 ms (p50 62.5, p95 75.8), sensing
52.1% / movement 21.8% / brain 20.0%; Chromium at MAX with 1 226 organisms: mean tick 5.6 ms,
sensing 52% / movement 25% / brain 14% / render snapshot 10%. Three independent spatial range scans
per organism per tick are the mechanism. Render pooling and LOD measured clean (0 dropped
snapshots, 1 buffer in flight, 0 organisms on the detail layer at world zoom), so **particle-layer
culling is deliberately not implemented** — docs/07's "if justified" was not met, and CLAUDE.md says
to optimize measured hotspots only. The named next step is folding the crowding count into the
creature scan, behind a "golden hashes must not move" gate.

**Calibration (L07), twelve seeds at 10 000 ticks.** 12/12 survive; median final population 5 156
against the docs/07 §7 target of 5 000. But **4 of 12 reach the 8 192 cap**, refusing 22 537 to
1 640 091 births, and population is still rising at tick 10 000 in 8 of 12 — so 4/12 is a lower
bound and docs/01 §12's release gate is not met. Capped seeds carry **30% less trait diversity**
(mean sd 0.0357 vs 0.0509), confirming ADR 0006's one-seed cap-bias finding at n = 12. All 12
saturate the carcass cap. Only 2 of 12 ate any meat at all.

The three findings share one cause — the world is too productive — and the named experiment
`experiments/carrying-capacity.json` demonstrates the lever: halving base plant capacity takes cap
refusals to **zero on all three previously-capped seeds**, cuts carcass overflow 2.5–4×, and makes
carnivory appear where it never had (17 294 meat units on a seed that ate none). 0.5 overshoots —
the reference seed lands at 1 118 organisms — so the factor needs its own calibration pass over
roughly 0.6–0.8 across all twelve seeds. **That pass is deliberately not folded into a measurement
milestone**: it ends in an `ENGINE_VERSION` bump and regenerated goldens and deserves its own gate
(ADR 0021 §0).

One real defect found by the new browser suite and fixed: **the History panel had no CSS**, so it
rendered under the top bar and the rewind scrubber was unclickable on a desktop viewport. No jsdom
test could have caught it.

Milestone 12 review gate: **PASS** (engine 0.7.0 and every golden hash unchanged, protocol 8
unchanged, ADR 0022). Everything M12 added was audited against the question a measurement milestone
has to answer first — can any of it change what it measures, and does any claim outrun its evidence.
No hash could have moved and none did; every headline number was re-read against what was actually
run, and the one adjustment is in the review rather than the milestone (carnivory under the halved
capacity is one seed in four, so "reachable and rare" rather than "solved").

Three defects and three gaps found and fixed:

1. **The long soak swept twice around every cadence boundary** — the next sweep was derived from
   `tick % checkEvery`, and a checkpoint lands the engine on an arbitrary tick. 17 sweeps where 11
   were due; nothing skipped, but at a million ticks the sweep is the second most expensive thing in
   the run. Same run, same final hash, 11 sweeps.
2. **The performance HUD would have counted the whole-tick total as one of its own phases** whenever
   the phase labels had not arrived yet, since it excluded the total by name and the fallback names
   are `phase 0`, `phase 1`, … Excluded by index now.
3. **The memory walker was drift-proof only for columns that are added**, not for one that becomes
   private — it would have kept returning a plausible, quietly-too-small number. Now bounded below
   per category against the organism cap.
4. **The browser suite could only ever test a local build.** `EON_E2E_BASE_URL` now points it at any
   served build, which is how a deployment gets verified without a manual browser session.
5. **The browser suite was not in CI**, which is how the Playwright task stayed open from Milestone 6
   to Milestone 12. `verify.yml` gains a Chromium + mobile job.
6. **The two soaks agreed and nothing checked that they did.** The golden soak hash now lives beside
   the world it describes; the test asserts it and the 1M CLI run verifies it in passing at tick
   100 000 and exits non-zero on a mismatch.

The release soak ran to completion during the review (68.7 min): every docs/07 §6 requirement
answered, and three results worth naming — **328 generations** with brains still recognisably
descended from the founder controller (mean cosine similarity 0.6228, **0.0000%** of weights on the
mutation clamp, so docs/07 §12's "mutation destroys brain too fast" is not happening); **memory flat**
at 9.35 MiB after a million ticks and 191 000 slot recycles; and **still one species**, extending
ADR 0013 §9's finding by an order of magnitude.

- [ ] L10 fold the crowding count into the creature vision scan (the measured hotspot; hashes must
      not move).
- [ ] L11 carrying-capacity calibration pass over 0.6–0.8 on twelve seeds, then apply — engine
      version bump plus regenerated goldens.

## M PWA/mobile
- [x] M01 installable/offline app shell — manifest, generated icons, a hand-written service worker
      whose cache generation rides on the build version, and an offline reload verified in a browser.
- [x] M02 touch/safe areas — the layout landed in M7; M13 adds the mobile *behaviour* that was
      missing: `overscroll-behavior: none`, landscape safe-area insets, no tap highlight, no text
      selection on chrome.
- [x] M03 lifecycle pause/resume — pause when hidden, resume at the user's speed, save on
      `pagehide`; a pause the USER made is never undone.
- [x] M04 Capacitor integration — `capacitor.config.ts` wraps this web build; the native projects
      are deliberately not committed (see below).
- [ ] M05 iOS device test — **blocked on hardware**, not on code. Needs macOS + Xcode +
      `npx cap add ios`. What stands between here and it is verified: the app passes all ten
      docs/07 PART E flows in **WebKit**, the engine iOS uses, plus a phone-sized touch viewport.
      The remaining risk is native-shell-specific: WKWebView storage under an app wrapper and
      memory pressure on a real device.
- [ ] M06 Android device test — **blocked on hardware**. Needs the Android SDK +
      `npx cap add android`. Remaining risk is the WebView version spread across devices.
- [x] M07 save/load validation — Milestone 10 made saves durable against failure; M13 addresses the
      mobile-specific one it could not: IndexedDB is evictable by default and Safari discards
      script-writable storage after about a week of non-use. The app now requests persistent
      storage once, after the first save, and reports which of the three answers it got —
      "no API" is never reported as "declined".

Milestone 13 gate: **PASS WITH NOTES** (engine 0.7.0 and every golden hash unchanged, protocol 8
unchanged, ADR 0023). Entirely presentation and hosting: docs/02 §20 forbids changing authoritative
ecology by device class, so there is no mobile code path, no reduced tick and no device-dependent
constant. Lifecycle pausing changes scheduling, never state, which is why this milestone cannot move
a hash even in principle.

Verified in a browser (44 browser tests across Chromium, Firefox, WebKit and a phone viewport): the
manifest is complete and every icon it names is actually served; the worker is served at the
deployment base and takes control; **the shell opens with the network switched off**, checked by
reloading an offline context; and lifecycle pause/resume works through a real `visibilitychange`.

One skip, documented in place: Playwright's WebKit build fails `page.reload()` with an internal
error once the context is offline, before any application code runs. The halves of that scenario
WebKit can answer are covered by the other tests.

**The note is M05/M06.** They are blocked on hardware this delivery environment does not have, and
nothing here claims otherwise. The native projects are deliberately absent too: `npx cap add` needs
Xcode or the Android SDK, and generating scaffolding nobody has built is worse than an honest gap.


## Final EON MVP audit (ADR 0024)

**Five of seven docs/01 §12 release gates pass.** Headless determinism, save/replay, ten-plus
surviving calibration seeds, a controlled selection experiment that shifts lineage success, and a
web UI that makes the outcomes inspectable — all met, with evidence in ADR 0024 §1.

**Two do not, and they share one cause.**

- **Gate 4, "population does not normally slam into engine cap":** 4 of 12 seeds reach the 8 192 cap
  by tick 10 000, and that is a floor — population is still rising in 8 of 12 at that tick. Capped
  seeds carry 30% less inherited variation. The lever is measured: halving base plant capacity takes
  cap refusals to zero on every capped seed, but 0.5 overshoots the population target.
- **Gate 6, "a calibrated divergent run creates an automatic species split":** the detector is proven
  in both directions on synthetic populations, but every long run of the real world ends with one
  species — 100 000 ticks, and now 1 000 000. The detector is correctly refusing to split a
  continuous cloud; it is the world that is not producing divergent pressure, for the same reason as
  gate 4.

The MVP is **feature-complete and not yet calibration-complete**: every mechanism exists, is tested,
is deterministic and is inspectable. What remains is one ecological tuning pass (**L11**) and the
speciation scenario it enables.

One defect found and fixed by this audit: **the A23 review's `EON_E2E_BASE_URL` did not work for the
deployment it was built for** — the tests navigated to `"/"`, which resolves to the origin root and
discards the `/EvoSim/` path a project Pages site lives under. With it fixed, the bytes GitHub Pages
is actually serving pass twelve browser scenarios, including the offline reload.

Contract audit (CLAUDE.md): engine purity, determinism, SoA layout, the React and renderer
boundaries, the four required version constants, the mandatory fixture, the workspace layout and
every scope exclusion — all clean. Details in ADR 0024 §2.

## Post-A25 integrity pass (ADR 0025)

- [x] N01 world-start flow — start screen (New World / Load World), New World preview
      screen (explicit seed, random, regenerate, layers, summary), explicit CREATE WORLD;
      created worlds open at exact tick 0 PAUSED with a persisted tick-0 baseline;
      discarded previews never persisted; `?seed=` deep-links into the New World screen;
      preview identity proven end to end (`environmentHash`, protocol 9).
- [x] N02 rewind as a user workflow — the scrubber offers exactly the reconstructable
      range (floor = earliest stored save; legacy gaps stated); stored checkpoints are
      visible chips; dragging only selects and the explicit View This Time button
      reconstructs; the present tick shown while previewing comes from the live world.
- [x] N03 branch auto-open — Branch From Here persists the branch, leaves the preview and
      opens the branch paused at the branch tick, with a banner, a standing lineage note,
      parent named on every branch row and per-world UI state rebound on switch; parent
      isolation re-verified down to the newest save hash in a real browser.
- [x] N04 expected-gain food choice — the docs/04 §20 categorical carcass gate (a measured
      fitness valley) replaced by expected obtainable energy with an explicit plant
      tie-break; scavenging becomes evolutionarily reachable without declaring roles.
- [x] N05 carrying-capacity calibration (closes L11) — plant capacities ×0.6 and carcass
      decay 20 → 48, chosen from a four-factor twelve-seed sweep plus 25 000-tick re-runs
      and head-to-head carcass levers (bigger store and 2× rot both measured and rejected
      for destabilizing the population gate). ENGINE_VERSION 0.8.0; every golden hash
      regenerated and independently re-verified.
- [x] N06 ecological speciation (closes release gate 6) — one continent, an equatorial
      channel flooded at tick 8 000 by ordinary LowerTerrain commands, two isolated demes,
      and the engine's own detector splits them at ~tick 45 000 (persisting 60 000 ticks);
      pinned as `fixtures/speciationScenario.ts` + `ecologicalSpeciation.test.ts` with a
      horizon assertion.

Post-A25 integrity gate: **PASS** (engine 0.7.0 → 0.8.0, protocol 8 → 9, ADR 0025). Every
original finding re-reproduced against the A22–A25 tip before changing anything (the
ADR 0021 table byte-identical on a four-seed subset). Final twelve-seed evidence on the
shipped config: 12/12 survive, **0/12 at the population cap** (max peak 6 677), **12/12
scavenging** (median 1.58M meat units against ≤300 before), carcass saturation episodic
instead of permanent (7/12 under the cap at tick 10 000, median skips 3 082 against
12/12 saturated), and the docs/01 §12 speciation gate covered by a deterministic test.
Costs stated in ADR 0025 §6: the suite gains the ~40-minute speciation run; the golden
fixture suite runs 2.6× faster on the leaner world.

## Post-A25 independent adversarial audit (ADR 0026)

An outside re-audit of the ADR 0025 claims: nothing was taken on the word of an ADR,
a checkbox, a test name or a comment. Every claim was traced in code or reproduced by
running it.

- [x] O01 calibration reproduced independently — `pnpm sweep` over the documented seed
      family (`FIXTURE_SEED + i × 7919`, i = 0…11) at 10 000 ticks on plain
      `DEFAULT_CONFIG` reproduces ADR 0025 §2d **exactly**: 12/12 survive, 0/12 refuse
      births (max peak 6 677), 12/12 scavenge (median 1 580 620 units), 7/12 under the
      carcass cap with median 3 082 skips, median population 2 699, median trait sd
      0.0347, kills 0. The ecological half of ADR 0025 stands as published.
- [x] O02 **rewind replayed a history that never happened** (P0) — docs/06 §24 step 3
      was not implemented: the replay ran on the base save's embedded command log, so
      any intervention accepted after that save was omitted, and Branch From Here
      persisted the resulting fiction as the parent's past. `Reconstruction` now takes
      the world line's full log (`authoritativeLog`) and re-cursors it; the host passes
      the live engine's own. Four engine and two host regression tests; every golden
      hash unchanged (the engine's rules did not move — only which command stream a
      rewind replays).
- [x] O03 **a refused load could destroy an unrelated world** (P1) — the session bound
      to the load target before the Worker accepted the bytes, so an autosave after a
      refusal wrote the still-running world's state into the refused world's manifest.
      Loads bind provisionally now; saving waits for the confirming WORLD_READY and a
      refusal restores the previous binding.
- [x] O04 **false fatal "world identity mismatch"** (P1) — the accepted preview's tick-0
      digest was compared against every later WORLD_READY, so a healthy in-session load
      or branch raised a fatal banner over a working world. Checked once now, against
      the created world only; a genuine mismatch pauses the world and persists nothing.
- [x] O05 preview integrity (P2/P3) — a load during a preview returns the history status
      to live; autosave and `saveOnHide` are gated on live mode (they were firing on
      historical ticks and reporting failures the user did not cause); the scrubber
      clamps a selection carried across a world switch so it can never offer a tick the
      new world cannot reach; `QUERY_STATE_HASH` can no longer step the preview engine.
- [x] O06 branch honesty (P3) — a branch that is written but cannot be opened now says
      so and names where to find it, instead of looking like nothing happened.

Two findings recorded and deliberately not changed (ADR 0026 §3): `earliestTick` in
HISTORICAL_MODE_READY is hardcoded to 0 and wrong for branch worlds, but no code reads
it; and `?view=generator` remains a developer view that builds an unpersisted
main-thread world outside the acceptance flow.

One E2E scenario needed a second look rather than a story (ADR 0026 §4): `world.spec.ts`
scenario 4 timed out on the first browser run, which looked like the leaner 0.8.0 world
making its click sweep miss. It was CPU contention — the run shared four cores with a
twelve-seed sweep and the full Vitest suite. Re-run on a quiet machine it passes in 168 s
and the whole Chromium project is 20/20. No test was retuned to get there.

Post-A25 independent audit gate: **PASS** (engine 0.8.0 unchanged, protocol 9 unchanged,
all six golden hashes unchanged, ADR 0026).
