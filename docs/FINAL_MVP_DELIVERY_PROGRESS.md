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
| A22 / M12    | Performance & calibration | **PASS** | `27c5d7c` | PASS | PASS |
| A23 / review | M12 hostile review        | **PASS** | `3986950` | PASS | PASS |
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
| Commit | `27c5d7c9770de3daf9b0fc1d459fc17b765b82ea`                        |
| Verify | **PASS** — 101 files, 1 269 tests, 3 108 s; every golden hash unchanged |
| E2E    | **PASS** — 32 tests across Chromium, Firefox, WebKit, mobile      |
| Pages  | **PASS** — run 31897632182; the live bundle contains the A22 SHA, and the deployed bytes run in a browser (seed 0xE0A12026, ticking, 256 organisms, zero console errors) |
| URL    | <https://martintoddler.github.io/EvoSim/>                         |

---

## A23 / Milestone 12 review

An adversarial pass over everything M12 added. Full findings in
`docs/adr/0022-milestone-12-review.md`; the gate is recorded in `TASKS.md`.

**No golden hash could have moved and none did.** Three defects and three gaps
found and fixed:

1. The long soak swept twice around every cadence boundary — 17 sweeps where 11
   were due. Same run, same final hash, 11 sweeps.
2. The performance HUD would have counted the whole-tick total as one of its own
   phases whenever the phase labels had not arrived yet.
3. The memory walker was drift-proof only for columns that are *added*, not for
   one that becomes private.
4. The browser suite could only ever test a local build — `EON_E2E_BASE_URL` now
   points it at any served build.
5. The browser suite was not in CI, which is how the Playwright task stayed open
   from Milestone 6 to Milestone 12.
6. The two soaks agreed and nothing checked that they did; the golden soak hash
   now lives beside the world it describes and the 1M CLI run verifies it in
   passing.

**The 1 000 000-tick release soak ran to completion during this stage** (68.7 min): 2 013 sweeps all
clean, 192 376 births / 190 904 deaths fully attributed, 328 generations, population 25–3 223,
snapshot round trip exact and continuation identical, memory flat at 9.35 MiB, and the hash at tick
100 000 equal to the Vitest soak's golden `a7e2b5e223c8657a`. Final hash `c0f11ebb61152ef3`.

Every headline number from A22 was re-read against what was actually run. One
adjustment, recorded in the review rather than the milestone: carnivory under
the halved capacity is one seed in four, so "reachable and rare" rather than
"solved".

### Status

| Field  | Value                                                         |
| ------ | ------------------------------------------------------------- |
| Status | PASS                                                          |
| Branch | `claude/evosim-a22-a25-delivery-t4itkl`                       |
| Commit | `398695044ddc7bc61a37edcd4ae1a906007eed4a`                    |
| Verify | **PASS** — 101 files, 1 270 tests; every golden hash unchanged |
| Soak   | **PASS** — 1 000 000 ticks, 2 013 sweeps clean                |
| Pages  | **PASS** — the live bundle carries the A23 SHA                 |

---

## A24 / Milestone 13 — PWA and mobile readiness

Tasks M01–M07. Entirely presentation and hosting: engine 0.7.0 and protocol 8
unchanged, every golden hash unchanged. docs/02 §20 forbids changing
authoritative ecology by device class, so there is no mobile code path — and
lifecycle pausing changes scheduling, never state, which is why this milestone
cannot move a hash even in principle. Decisions in
`docs/adr/0023-milestone-13-pwa-and-mobile.md`.

### Delivered

- **Installable, offline app shell** (M01): web manifest, generated icons
  (192/512/maskable/iOS, rendered from the favicon shape through a longhand PNG
  encoder), and a hand-written service worker whose cache generation rides on
  the build version — `sw.js` is byte-identical between builds, so without it a
  user would keep the old worker forever.
- **Mobile behaviour** (M02) the M7 layout work did not cover:
  `overscroll-behavior: none` so a pan at a sheet edge cannot pull-to-refresh
  and discard the running world, landscape safe-area insets, no tap highlight,
  no text selection on chrome.
- **Lifecycle pause/resume** (M03): pause when hidden, resume at the user's
  speed, save on `pagehide`; a pause the *user* made is never undone.
- **Capacitor boundary** (M04): `capacitor.config.ts` wraps this web build; the
  native projects are deliberately not committed.
- **Storage a phone will keep** (M07): the app asks for persistent storage once
  after the first save and reports which of the three answers it got.

### Verified

44 browser tests across Chromium, Firefox, WebKit and a phone viewport. The
manifest is complete and every icon it names is served; the worker is served at
the deployment base and takes control; **the shell opens with the network
switched off**; lifecycle pause/resume works through a real `visibilitychange`.
One documented skip: Playwright's WebKit fails `page.reload()` internally in an
offline context, before any application code runs.

### Note

**M05 and M06 — real iOS and Android device tests — are not done**, and nothing
here claims they are. They need hardware and native toolchains this environment
does not have. What stands between here and them is verified: all ten docs/07
PART E flows pass in WebKit, the engine iOS uses, plus a phone-sized touch
viewport. The remaining risk is native-shell-specific.

### Status

| Field  | Value                                                          |
| ------ | -------------------------------------------------------------- |
| Status | PASS WITH NOTES (M05/M06 blocked on hardware)                  |
| Branch | `claude/evosim-a22-a25-delivery-t4itkl`                        |
| Commit | `00e29bb6efa93034f75ddfb8330c32f4029b5df9`                     |
| Verify | **PASS** — 104 files, 1 294 tests; every golden hash unchanged  |
| E2E    | **PASS** — 44 tests, Chromium / Firefox / WebKit / phone        |
| Pages  | **PASS** — the live bundle carries the A24 SHA; manifest, service worker and icons all served |

---

## A25 / Final EON MVP audit

The last gate before the MVP can be called finished, against docs/01 §12's seven
release conditions. Full evidence in `docs/adr/0024-final-mvp-audit.md`.

### Verdict: five of seven gates pass

| Gate                                                | Verdict                                     |
| --------------------------------------------------- | ------------------------------------------- |
| 1. Headless determinism                              | **PASS** — fixture, 100k and 1M soaks, cross-platform matrix |
| 2. Save / replay                                     | **PASS** — M10 acceptance, M11 branch equality, 1M round trip |
| 3. 10+ calibration seeds survive startup             | **PASS** — 12/12, median final population 5 156 |
| 4. Population does not normally slam into the cap    | **FAIL** — 4/12 seeds at the cap, and that is a floor |
| 5. Controlled selection experiment shifts success    | **PASS** — the diet-selection experiment    |
| 6. A divergent run creates an automatic split        | **FAIL** — synthetic both ways; no ecological split |
| 7. Web UI makes the outcomes inspectable             | **PASS** — live, installable, offline       |

**The two failures share one cause**: the reference world is too productive, so
no region is scarce enough to push population off the cap or to make a different
strategy pay. The lever is measured (halving base plant capacity zeroes cap
refusals on every capped seed and produced the project's first emergent
carnivory) and the remaining work is scoped as **L11** — a factor pass over
0.6–0.8 across twelve seeds, then the config change, which bumps
`ENGINE_VERSION` and regenerates every golden hash.

**The MVP is feature-complete and not yet calibration-complete.** Every mechanism
docs/01 asks for exists, is tested, is deterministic and is inspectable in a
browser a user can install.

### One defect found and fixed by the audit

**`EON_E2E_BASE_URL`, added by the A23 review so the suite could verify a
published build, did not work for the deployment it was built for.** The tests
navigated to `"/"`, and `new URL("/", "http://host/EvoSim/")` resolves to the
origin root — so pointed at the real project Pages site it loaded a directory
listing and failed eleven scenarios with "topbar not found", which reads like an
application failure and is not one. Fixed; the bytes GitHub Pages actually serves
now pass twelve browser scenarios including the offline reload.

### Contract audit

Engine purity, determinism, SoA layout, the React and renderer boundaries, the
four required version constants, the mandatory fixture, the workspace layout and
every scope exclusion: all clean (ADR 0024 §2).

### Status

| Field  | Value                                                          |
| ------ | -------------------------------------------------------------- |
| Status | COMPLETE                                                       |
| Branch | `claude/evosim-a22-a25-delivery-t4itkl`                        |
| Commit | _this commit_                                                  |
| Verify | **PASS** — 104 files, 1 294 tests; every golden hash unchanged  |
| E2E    | **PASS** — against the bytes GitHub Pages is serving            |
| Pages  | _deployed immediately after this commit_                       |
| URL    | <https://martintoddler.github.io/EvoSim/>                      |
