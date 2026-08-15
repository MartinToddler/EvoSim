# ADR 0024 — Final EON MVP audit

Status: accepted · Date: 2026-08-15 · Engine 0.7.0 · Protocol 8 · Snapshot schema 8 · Config schema 7

The last gate before calling the MVP finished. docs/01 §12 lists seven conditions; this document
answers each one with evidence rather than with a claim, and says plainly which are not met.

**Verdict: five of seven gates pass. Two do not, and they share one cause.** The engine, the
determinism contract, persistence, rewind, the observation UI and the installable shell are all
where they should be. What is not finished is _ecological calibration_: the reference world is too
productive, which pushes a third of seeds into the population cap and leaves the evolved population
a single continuous cloud that correctly refuses to speciate. The lever is identified, measured and
demonstrated (ADR 0021 §5b); pulling it is a change that bumps `ENGINE_VERSION` and regenerates every
golden hash, and it is tracked as L11.

## 1. The seven MVP release gates

### ✅ 1. Headless determinism passes

The mandatory fixture (CLAUDE.md) is in place and green: seed `0xE0A12026`, `DEFAULT_CONFIG`, a
nine-command fixture log covering every intervention kind, and canonical hashes at ticks 0, 1, 10,
100, 1 000 and 10 000. `pnpm verify` reproduces all six on every run, plus the config digest
`a1157fd0201ed348`.

Beyond the fixture: the 100 000-tick Vitest soak, the **1 000 000-tick release soak** (2 013
invariant sweeps clean, ADR 0022 §2.5), a cross-platform CI matrix (macOS, Windows, Node 24) that
re-runs the engine suite and the headless CLI, and a Worker-vs-headless equivalence harness. The 1M
run reproduces the 100 000-tick golden hash in passing, so the long soak is provably the short soak
at scale.

### ✅ 2. Save/replay passes

Milestone 10's acceptance test: a world saved at tick 2 500 and reloaded into a fresh runtime reaches
tick 10 000 with the same canonical hash as one that never stopped. Milestone 11 extends it to
rewind and branching — a control run, a branch taken at 5 000 with no new commands, and a branch at
6 234 that needed save + replay to reconstruct all reach the identical hash. The 1M soak adds a
round trip at tick 1 000 000 that restores exactly and then continues identically.

### ✅ 3. At least 10 calibration seeds survive reasonable startup

Twelve seeds, 10 000 ticks each: **12/12 survive** (ADR 0021 §5). Median final population 5 156
against the docs/07 §7 desktop design target of 5 000. All twelve generate valid worlds on the first
attempt.

### ❌ 4. Population does not normally slam into the engine cap

**Not met.** Four of twelve seeds reach the 8 192 cap by tick 10 000, refusing between 22 537 and
1 640 091 births. And 4/12 is a _floor_, not an estimate: population is still rising at tick 10 000
in eight of twelve seeds, so more of them are on the way. An earlier six-seed sample on a different
seed family found 3/6 (ADR 0006 §7), so two independent samples agree it is roughly half the worlds.

It matters beyond the counter. Capped seeds carry **30% less inherited variation** than uncapped ones
(mean per-gene sd 0.0357 against 0.0509), because refusal is by iteration order rather than by
ecology — precisely the bias docs/01 §11 warns about.

**The lever is measured.** Halving `plants.baseCapacityByBiome` takes cap refusals to **zero on every
previously-capped seed** (`experiments/carrying-capacity.json`). A factor of 0.5 overshoots — the
reference seed lands at 1 118 organisms against a 5 000 target — so the remaining work is a pass over
roughly 0.6–0.8 across all twelve seeds, then the config change itself. Tracked as **L11**.

### ✅ 5. A controlled selection experiment demonstrably shifts lineage success

`predationSimulation.test.ts` → "diet selection (docs/07 §5)": two genotypes identical in every gene
except the signed diet gene, in two worlds that differ only in which food exists, with mutation
switched off so the diet gene is the _only_ difference the result can come from. The matching
specialist gains realized reproductive share in each world — which is the only kind of fitness this
project has (docs/05 §1).

### ❌ 6. At least one calibrated fragmented / environmentally divergent run creates an automatic split

**Not met, and this is the honest reading of a partial result.**

What exists: the detector is proven in both directions on synthetic populations — a bimodal
two-cloud world splits at exactly the fifth stable analysis, a single noisy cloud never splits, and a
pending split survives snapshot/restore and lands on the identical tick (ADR 0013, thirteen
fixtures). That is docs/07 §16's synthetic positive and synthetic negative.

What does not exist is docs/07 §16's third bullet — the **ecological** scenario, where geographic
separation and distinct pressure produce a split in a world nobody hand-built. Every long run of the
real world ends with **one species**: 100 000 ticks (ADR 0013 §9) and now 1 000 000 ticks
(ADR 0022 §2.5, 328 generations).

That is not a defect in the detector. The detector is refusing to split a continuous cloud, which is
exactly what docs/05 §7 requires of it. It is the _world_ that is not producing divergent pressure —
and §4's finding says why: at 53–80% of a very large plant capacity, no region is scarce enough to
make a different strategy pay. The two gates fail for the same reason, and the §4 experiment is
suggestive on this one too: halving capacity produced the project's first emergent carnivory (17 294
units of meat on a seed that had eaten none), which is the kind of niche divergence a split would
have to come from.

The named next step is therefore **L11 first, then an ecological speciation scenario measured on the
recalibrated world** — not a change to the detector.

### ✅ 7. The web UI makes these outcomes inspectable

Live at <https://martintoddler.github.io/EvoSim/>, installable, and working offline. Organism
inspector with vitals, inherited traits, running costs and the last tick's brain inputs and intents;
bounded-memory charts of population, biomass, birth/death rates and trait drift; nine world data
layers; the species panel, Tree of Life and history timeline; nine intervention tools; save, load,
rewind and branch; and — new in Milestone 12 — a performance HUD showing the tick profile against
docs/07 §8's budgets and the memory report by category.

Every one of the failures above is visible _in the app_: the population counter carries a cap warning
with the refused-birth count, the species panel shows one lineage, and the timeline records the
`PopulationCapReached` episodes.

## 2. Contract audit

| CLAUDE.md rule                                            | Status                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| Engine imports no React/Pixi/DOM/IndexedDB/wall clock     | Clean — enforced by ESLint, verified by grep over the whole package  |
| No `Math.random`, `Date.now`, `performance.now` in engine | Clean — the only occurrences are comments explaining the rule        |
| Fixed ticks, seeded PRNG, explicit tie-breaks             | Clean — PRNG unreachable outside the package (`internal.ts` WeakMap) |
| SoA + TypedArrays, no per-tick allocation in hot loops    | Clean — `EngineScratch` is the reused working memory                 |
| React never holds organism positions                      | Clean — telemetry at ~2 Hz; render state never enters React state    |
| Renderer decides nothing                                  | Clean — `@eon/renderer` cannot import the engine                     |
| All tuning in `SimulationConfig` / named constants / LUTs | Clean                                                                |
| Required version constants                                | All four present; protocol and host runtime schema versioned too     |
| Mandatory fixture with hashes at 0/1/10/100/1k/10k        | Present and green                                                    |
| Version bump + regenerated hashes + changelog on change   | Followed — M12 and M13 moved no hash and bumped no engine version    |
| Workspace layout                                          | Matches, plus `e2e/` and `experiments/`                              |
| Scope exclusions (sexual reproduction, NEAT, aquatic, …)  | None implemented                                                     |

`packages/engine` runs in Node with no browser present, which the whole test suite demonstrates on
every run.

## 3. What this audit found and fixed

**The A23 review's deployment-targeting fix did not work for the deployment it was built for.**
`EON_E2E_BASE_URL` was added so the browser suite could verify a published build, but the tests
navigated to `"/"` — and `new URL("/", "http://host/EvoSim/")` resolves to the _origin root_,
discarding the repository path that a project Pages site lives under. Pointed at a real deployment it
loaded a directory listing and failed eleven scenarios with "topbar not found", which reads like an
application failure and is not one.

Fixed by making the tests navigate relatively (`"./"`) and the configured base always end in a
slash. It is exactly the class of bug the option existed to catch, one layer up: a URL that is silent
at build time and wrong at run time.

With the fix, **the bytes GitHub Pages is actually serving pass twelve browser scenarios**, including
the offline reload and lifecycle pause/resume.

## 4. Open work, named

| Task    | What                                                               | Why it is open                                                                                              |
| ------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **L11** | Carrying-capacity calibration pass (0.6–0.8 × twelve seeds), apply | Closes gate 4; bumps `ENGINE_VERSION`, regenerates goldens                                                  |
| **L10** | Fold the crowding count into the creature vision scan              | The measured hotspot (52% of the tick); hashes must not move                                                |
| —       | Ecological speciation scenario on the recalibrated world           | Closes gate 6; depends on L11                                                                               |
| **M05** | iOS device test                                                    | Blocked on macOS + Xcode hardware                                                                           |
| **M06** | Android device test                                                | Blocked on the Android SDK                                                                                  |
| **J09** | Optional organism translocation                                    | Labelled "late-MVP if schedule permits" in docs/01 §4; the one command whose payload the docs never specify |

## 5. Verdict

The MVP is **feature-complete and not yet calibration-complete.** Every mechanism docs/01 asks for
exists, is tested, is deterministic and is inspectable in a browser that a user can install. What
remains before "MVP finished" can honestly be said is one ecological tuning pass and the speciation
scenario it enables — both scoped, both measured, and neither of them a repair.
