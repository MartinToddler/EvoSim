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
| Commit SHA           | _recorded below on commit_                                                  |
| Engine version       | 0.8.0 (unchanged)                                                           |
| Config schema        | 7 (unchanged)                                                               |
| Snapshot schema      | 8 (unchanged)                                                               |
| Protocol version     | 9 (unchanged)                                                               |
| `pnpm verify`        | _recorded below_                                                            |
| Deployment           | _recorded below_                                                            |

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

---

_Stages M14 through the final audit are appended below as they complete._
