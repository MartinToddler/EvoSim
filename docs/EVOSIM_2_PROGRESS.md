# EvoSim 2.0 — Delivery Progress

Per-stage evidence for the EvoSim 2.0 roadmap (`docs/11_EVOSIM_2_0.md`, ADR 0027).
`TASKS.md` remains the authoritative implementation checklist; this file is the running
record of what was built, what it measured and where it was deployed.

**Active development branch:** `claude/evosim-2-0-implementation-7sjovi`
**Baseline:** `28b686e` — _Audit: state the scavenging magnitude, and confirm gate 6 by
running it_ (2026-08-16), engine 0.8.0 / protocol 9 / snapshot 8 / config 7.
**Deployment target:** https://martintoddler.github.io/EvoSim/ via the `deploy-pages.yml`
workflow (`workflow_dispatch` on the active branch).

## Baseline verification

The starting commit was confirmed to contain the completed New World flow with tick-0 paused
world creation (N01), persistence (Milestone 10 / K), rewind as a user workflow (N02, fixed by
O02), branching with auto-open and parent isolation (N03, O03/O04), the post-A25
predation/calibration corrections (N04 expected-gain food choice, N05 carrying-capacity
calibration), A22 performance and calibration (L), A24 PWA/mobile (M), and the A25 final audit
(ADR 0024) plus the independent post-A25 audit (ADR 0026).

Branch reconciliation: all 22 remote branches were compared by ancestry. `origin/main` and
`origin/claude/evosim-a22-a25-audit-dctjyw` are the same commit; every other branch is an
ancestor of it. Four stale review branches carry commits that are not ancestors
(`claude/evosim-project-setup-ps3fry`, `claude/m2-5-review-visualizer-54i8qn`,
`claude/m6-architecture-review-56mj9k`, `claude/milestone-2-5-debug-visualizer-30yxby`), all of
them pre-rebase duplicates of Milestone 2.5/6 work that the trunk already contains 47–59
commits past. No unmerged valid work exists off-trunk; nothing was discarded.

---

## Stage log

### PHASE 0 — EvoSim 2.0 architecture and implementation contract

| Field                | Value                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| Status               | complete                                                                    |
| Branch               | `claude/evosim-2-0-implementation-7sjovi`                                    |
| Commit SHA           | `216635e261326afea2b6d28514dcde9a1849e2f4`                                  |
| Engine version       | 0.8.0 (unchanged)                                                           |
| Config schema        | 7 (unchanged)                                                               |
| Snapshot schema      | 8 (unchanged)                                                               |
| Protocol version     | 9 (unchanged)                                                               |
| `pnpm verify`        | PASS — 106 files / 1331 tests in 3813 s, build OK                           |
| Deployment           | success (run 31948395998), verified live                                    |
| Deployment URL       | https://martintoddler.github.io/EvoSim/                                     |

**Scope.** Documentation only — no engine, protocol, renderer, persistence or UI code changed,
so every golden hash is unchanged by construction.

**Delivered.**

- `docs/11_EVOSIM_2_0.md` — the complete M14–M25 roadmap: pipeline, content, trade-offs and
  acceptance criteria per milestone, plus the four contracts (determinism, authoritative
  state, engine purity, costed benefits) every milestone inherits.
- `docs/adr/0027-evosim-2-0-emergence-first.md` — the governing architecture decision.
  Emergence first, in four operational parts: no authoritative behavior classes, no scripted
  behavior functions, derived labels allowed and encouraged, every benefit costed. Records the
  alternatives that were rejected and why.
- `CLAUDE.md` — rewritten from an MVP contract into a staged one. The flat "scope exclusions
  until explicitly approved" list is replaced by the approved-systems table with milestone
  assignments, the staged development rule, the emergence-first rule with its forbidden
  identifier shapes, the trade-off rule, the evolutionary accessibility rule, the boundedness
  rule, and a documentation-source-of-truth clause. Every MVP hard rule (engine purity,
  determinism, SoA, React/renderer boundaries, version constants, mandatory fixture, profiling,
  definition of done) is preserved, and the determinism section gained the explicit list of
  forbidden authoritative inputs and an authoritative-state subsection.
- `docs/EVOSIM_2_PROGRESS.md` — this file.
- `TASKS.md` — EvoSim 2.0 section opened.
- `CHANGELOG.md` — entry.

**Deferred:** none.

**Deployment verification.** The served bundle embeds `VITE_APP_VERSION`, so the live site was
confirmed to be this exact commit by fetching `assets/index-*.js` and matching
`216635e261326afea2b6d28514dcde9a1849e2f4` in it — not by trusting a green workflow.

---

### M14 — Morphological genome

| Field            | Value                                                             |
| ---------------- | ----------------------------------------------------------------- |
| Status           | complete                                                          |
| Branch           | `claude/evosim-2-0-implementation-7sjovi`                          |
| Commit SHA       | _recorded on commit_                                              |
| Engine version   | 0.8.0 → **0.9.0**                                                 |
| Config schema    | 7 → **8**                                                         |
| Snapshot schema  | 8 → **9**                                                         |
| Protocol version | 9 → **10** (render snapshot layout 1 → 2)                          |
| ADR              | 0028                                                              |

**Delivered.** A 27-gene morphological genome inherited and mutated like the ecological one;
a bounded deterministic developmental interpreter producing a derived, never-hashed
`MorphologyStore`; a dedicated structural mutation class for the two integer loci; 27 bytes of
developed body per organism on the render wire against a fixed quantization scale; procedural
bodies at two LODs (proportioned particles for thousands, cached procedural textures for the
budgeted detail layer); and a `?view=morphology` gallery built on the exact production
develop → encode → paint path.

**Important tests.** 27 morphology tests and 9 geometry tests. Gene-space: exact quantization
round-trip over the whole Q range, structural bucket stability under a 1 % nudge, no gene named
for an animal or a role. Development: purity, and every field inside its configured bounds over
400 random genomes. Mutation: class-partition boundaries, ±1 structural steps reflecting at the
bounds, determinism, 5 000-generation range safety, block isolation, and 60 000-generation
reachability of both ends of the range and every appendage-pair count. Integration: founder
identity, zero-mutation clone over 4 000 ticks, ordinary-mutation divergence over 6 000 ticks,
hash membership, snapshot round-trip equality including the rebuilt derived cache, engine ↔
protocol channel mirror, and projection purity. Geometry: determinism, closed outline, frame
containment for every possible channel block, and `fitScale === 1` for every body the shipped
config can grow.

**Evolutionary observations.** Twelve-seed sweep of `DEFAULT_CONFIG` at 10 000 ticks on engine
0.9.0: **12/12 survive**, median population 2 414 (0.8.0: 2 699), median peak 2 986, **0 seeds
at the population cap**, **12/12 eating meat** (median ~1.7 M units), median per-gene trait sd
0.0343 (0.8.0: 0.0347), kills 0. The regime is unchanged, which is the expected result —
morphology has no physical consequence until M15, so what M14 changed ecologically is the
random stream, not the rules.

**Performance.** Per organism: 54 bytes of authoritative morphological genome, a derived cache
of 30 arrays, and 27 bytes in each pooled render-snapshot buffer. Development is a fixed
sequence of bounded mappings — no loop's trip count depends on the genome — so growing a body
costs the same for every body. The detail-layer texture cache is a bounded LRU sized above the
detail budget. The populated soak run went from 407 s to 557 s, entirely because the fixture
world grew (below).

**Defects found by this milestone's own gate, and fixed.**

1. **The geometry could leave its sprite frame** (found by the frame-containment test). A body
   is now shrunk uniformly to fit rather than clipped, because clipping silently amputates a
   tail and reads as a short lineage. A second test pins the guard inert for every body the
   shipped config can grow.
2. **The populated soak fixture was a coin flip, not an instrument.** Its 96-cell world
   oscillates between peaks near 2 400 and troughs near 50, so surviving 100 000 ticks depended
   on the stream; 0.9.0's lost the toss and the world went extinct at ~tick 70 000. Diagnosed
   rather than assumed: the same fixture survives on other seeds (troughs 64 and 44), and the
   twelve-seed sweep above shows the shipped ecology unchanged. The fixture map is now 144
   cells with 96 founders, measured to survive on the fixture seed and three alternates. No
   `DEFAULT_CONFIG` value changed and no assertion was weakened.
3. **`scripts/regenerateSoakHashes.ts` restated the soak config instead of importing it**, so
   it regenerated a hash for a world nobody runs — it reproduced the old 96-cell number even
   after the fixture grew. It now imports `SOAK_CONFIG`.
4. **MVP release gate 6 was a lottery ticket** (ADR 0028 §6). `ecologicalSpeciation.test.ts`
   failed: no split by tick 60 000, and none by 88 000 on a probe. The cause is in the config,
   not the trace — the temperature cline is symmetric about the equator, so once the channel
   isolated the two demes they sat in mirror-image environments and only **drift** separated
   their centroids. Drift crossed the threshold at ~45 000 on 0.8.0's stream and not at all on
   0.9.0's. ADR 0027 §3b forbids exactly this shape of test. The scenario is now
   selection-driven: ordinary `PaintTemperature` commands put the hemispheres 24 °C apart the
   moment the channel opens, so `Gene.ThermalOptimum` is pushed in opposite directions by
   realized survival. Measured: split by tick 73 000 with the population healthy throughout
   (300 – 2 300). Horizon 60 000 → 90 000. A 64 °C differential was measured and rejected — it
   splits at 78 000 but collapses the population to tens first, trading one lottery for
   another.
5. **The persistence layer never learned about the new gene block.** `snapshotShape.ts` drives
   the binary codec from a field descriptor, and `organisms.morphGenes` was missing from it, so
   a save would have silently dropped every body. Caught by the shape and round-trip tests.

**Deferred (P2).** One of the four measured seeds bottoms out at 6 live organisms on the
enlarged soak map, so this is more headroom rather than proof against a future stream shift. If
a later milestone's stream kills it again, the fix is a larger map, not a weaker assertion.

**Deferred (P2).** The speciation gate now costs over an hour of suite time (192² world, up to
90 000 ticks). Every cheaper option measured tilts the experiment — a raised mutation rate, a
lowered split threshold, or a smaller and noisier world — so the cost is accepted rather than
optimised away. The split tick was measured on the fixture seed only; a multi-seed
reachability sweep belongs in the final audit (F-02), not in the per-commit gate.

---

_Stages M15 through the final audit are appended below as they complete._
