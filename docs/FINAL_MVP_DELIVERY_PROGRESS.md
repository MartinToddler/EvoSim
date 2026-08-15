# Final MVP delivery progress (A22–A25)

Stage-by-stage record of the final EON MVP delivery run, so progress survives an
agent session and can be followed on GitHub without reading the diff.

This file is **not** a replacement for `TASKS.md`, which stays the authoritative
task checklist, or for the ADRs, which stay the authoritative record of
decisions. It is a delivery log: what ran, what it said, and where it landed.

**Active development branch:** `claude/evosim-a22-a25-delivery-t4itkl`
**Branch point:** `5c08381cb49191b11de08105af7cc268444ccc94` — "Recover the
Milestone 2.5 world generator" (2026-08-15), the tip of `main` and of
`claude/eon-milestone-11-rewind-iwdlp7`, which are identical and carry the full
Milestone 0–11 history.

| Stage        | Scope                     | Status  | Commit | Verify | Pages |
| ------------ | ------------------------- | ------- | ------ | ------ | ----- |
| A22 / M12    | Performance & calibration | pending | —      | —      | —     |
| A23 / review | M12 hostile review        | pending | —      | —      | —     |
| A24 / M13    | PWA & mobile readiness    | pending | —      | —      | —     |
| A25 / audit  | Final MVP audit           | pending | —      | —      | —     |

---

## A22 / Milestone 12 — Performance and calibration

**Scope:** tasks L01–L09. Engine 0.7.0 unchanged and every golden hash
reproduced; `PROTOCOL_VERSION` 7 → 8 for two diagnostics. Decisions in
`docs/adr/0021-milestone-12-performance-and-calibration.md`.

### Delivered

- `pnpm benchmark:engine` — every field docs/07 §9 asks for (L01).
- `estimateEngineMemory` plus `RenderBufferPool.allocatedBytes` and chart
  retention, surfaced together (L03).
- A performance HUD on the development overlay, which finally displays the
  `phaseMillis` the profiler has produced since Milestone 6 (L02, L04).
- `pnpm soak:long` — the 1 000 000-tick release soak, sharing one world and one
  invariant sweep with the 100 000-tick Vitest soak (L06).
- The twelve-seed calibration study and the named carrying-capacity
  experiment (L07).
- A Playwright suite covering all ten docs/07 PART E scenarios, on Chromium,
  Firefox, WebKit and a mobile viewport (L08, L09).

### Results

**Performance.** The hotspot is **sensing, at 52% of the tick, in both Node and
a browser** — three independent spatial range scans per organism per tick.
Node benchmark at 5 000–8 192 organisms on the delivery container: mean tick
60.958 ms, p50 62.502, p95 75.826, sensing 52.1% / movement 21.8% / brain 20.0%.
Chromium at MAX with 1 226 organisms: mean tick 5.60 ms, sensing 52% / movement
25% / brain 14% / render snapshot 10%, zero dropped snapshots. Particle-layer
culling was measured and deliberately **not** implemented.

**Calibration.** 12/12 seeds survive; median final population 5 156 against the
5 000 design target. **4 of 12 hit the 8 192 cap** and 8 of 12 are still rising
at tick 10 000, so docs/01 §12's release gate is not met. Capped seeds carry 30%
less trait diversity. 12/12 saturate the carcass cap; 2/12 ate any meat.
Halving base plant capacity takes cap refusals to zero on every capped seed and
produces the project's first emergent carnivory — but overshoots population, so
the factor needs its own pass. Left as tasks L10/L11 rather than folded in.

**Browser suite.** 32 tests green across Chromium, Firefox and WebKit. It found
one real defect on its first run: **the History panel had no CSS**, so it
rendered under the top bar and the rewind scrubber was unclickable. Fixed.

### Status

| Field  | Value                                                             |
| ------ | ----------------------------------------------------------------- |
| Status | PASS                                                              |
| Branch | `claude/evosim-a22-a25-delivery-t4itkl`                           |
| Commit | _recorded at A23_                                                 |
| Verify | **PASS** — 101 files, 1 269 tests, 3 108 s; every golden hash unchanged |
| E2E    | **PASS** — 32 tests across Chromium, Firefox, WebKit, mobile      |
| Pages  | _recorded at A23_                                                 |
| URL    | <https://martintoddler.github.io/EvoSim/>                         |
