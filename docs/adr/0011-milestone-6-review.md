# ADR 0011 — Milestone 6 review: worker host, render transport and renderer

Status: accepted · Date: 2026-08-14 · Engine 0.5.0 (unchanged) · Protocol 2 (unchanged) · Review of tasks G01–G10

Independent architecture, concurrency, determinism and performance review of the Milestone 6 line
(`46ea397` and its follow-ups through `b6eb21f`): the protocol unions and packed buffer layouts in
`@eon/protocol`, `SimulationHost` and `WorkerClient`, the engine's render projections and profiling
hooks, `EonRenderer`, and the React shell. Reviewed against the 26 hostile-review categories in the
review brief and the mandated validation scenarios.

**No P0 or P1 defects were found.** The milestone's central guarantees — one loop, one engine, no
wall-clock influence, snapshots droppable and ticks not, worker/headless hash equality — held up
under every attack this review constructed. Five contained P2/P3 defects were found and fixed, none
of them able to change a hash: **`ENGINE_VERSION` stays 0.5.0, `PROTOCOL_VERSION` stays 2, and
every golden hash is unchanged**, verified by a full `pnpm verify` and by independent equivalence
runs before and after the fixes.

## 0. Method

A10's report and ADR 0010 were treated as claims, not evidence. The scheduler arithmetic was
re-derived from `SimulationHost.ts` rather than from its comments; the pool invariant was checked
against each `release` path rather than against the test that asserts it; and the review's own
probes were written before reading the shipped tests they overlap. Independent validation ran in
three layers:

1. **Adversarial host tests** (`SimulationHost.adversarial.test.ts`, added): the same
   worker-vs-headless hash comparison A10 shipped, but under hostile traffic _while the world
   runs_ — malformed messages, wrong protocol versions, foreign and detached recycle buffers,
   queries for entities that never existed, a fully starved render pool, a 30-round pause/resume
   storm alternating ×100 with MAX, 20 rounds of rapid speed cycling, and a mid-run DISPOSE
   followed by a from-scratch replacement host. Every scenario must land on the exact
   `stepMany(N)` hash, and does.
2. **`pnpm equivalence` re-run independently** on the real default world, at tick 1 000 and at
   tick 10 000. Worker, headless and committed golden fixture agree: `f21e8203dbcaf2b7` at 1 000
   and `f58bac3bde3256f3` at 10 000 — the same hash ADR 0010 §8 reports, reproduced on different
   hardware from a different driver program state.
3. **A real Chromium run** against the production build (SwiftShader GL, so the absolute numbers
   are a floor, not a ceiling): pause exactness, pause/resume storms, speed-cycling storms, MAX
   responsiveness, selection and inspector, selected-entity death, resize, reload-as-worker-
   recreation, and a grown ~2 000-organism world, with console and page errors failing the run.

## 1. Fixed (P2): a renderer that fails to start leaves the world running invisibly

`EonRenderer.create` rejecting (no WebGL, lost context) was reported as a fatal error — the fix in
A10's own self-review — but the Worker kept ticking. The page then showed "Simulation stopped"
over a simulation that was in fact running at full speed with no renderer, no picture and no way
to ever get one, indefinitely. An error banner that misstates the system's state is a defect in a
project whose first observability promise is that the UI tells the truth.

`WorldSession` now pauses the simulation on that path before reporting. The world is intact — a
future "retry renderer" affordance could resume it — but it no longer burns CPU behind a banner
claiming the opposite. (`apps/web/src/app/WorldSession.ts`)

## 2. Fixed (P2): a replacement world inherited the previous world's stream state

`INIT_NEW_WORLD` rebuilt the pools and cadence clocks but not `#renderStreamEnabled` or
`#behindTarget`. A worker whose render stream had been suspended (hidden tab) and then received a
second `INIT_NEW_WORLD` opened the new world blind: the "a paused world must still be visible"
snapshot was silently skipped, and the first telemetry could report `behindTarget` about a loop
that no longer existed. Unreachable through today's app — `WorldSession` creates a fresh Worker
per world — but reachable through the protocol, and the protocol is the contract.
(`apps/web/src/worker/SimulationHost.ts`, test in `SimulationHost.test.ts`)

## 3. Fixed (P3): the pool invariant did not survive a release into an all-idle pool

`RenderBufferPool.release` (and the vegetation pool's) checked shape but not flight: a same-shape
buffer released while `inFlight === 0` was adopted into `idle` with no matching decrement,
growing the pool past `created` — a slow leak of exactly the kind the pool's documented invariant
(`created === idle + inFlight`) exists to forbid. The plausible source is not an attacker but a
previous world with an identical config, whose in-flight buffers come back after a new world's
pools are built. A release when nothing is in flight cannot be a return of ours and is now
refused; the detached-buffer slot-free is gated the same way, so a stray detached recycle can no
longer erode `created` for a slot that was never occupied.
(`packages/protocol/src/renderSnapshot.ts`, `terrainSnapshot.ts`, tests in both `.test.ts` files)

## 4. Fixed (P3): a stale fatal error left other requests hanging

A10's self-review made a fatal ERROR reject every pending request — but only on the branch where
its own `requestId` was still pending. A fatal error whose request had already been settled (or
was never issued by this client) reached the error handler and swept nothing, leaving every other
outstanding promise pending forever. Not reachable today, because the only fatal paths carry no
`requestId`; one line makes the sweep unconditional so the guarantee stops depending on that
coincidence. (`apps/web/src/worker/WorkerClient.ts`, test in `WorkerClient.test.ts`)

## 5. Fixed (P3): two smaller ones

- **`queryEntity.ts` hard-coded `256` for the velocity scale** with a comment pointing at
  `movement.ts`, while `renderSnapshot.ts` imported `VELOCITY_SCALE` properly. A future change to
  the scale would have silently corrupted every inspector speed readout. It now imports the
  constant — CLAUDE.md's "no unexplained magic constants", applied to an explained-but-duplicated
  one. (`packages/engine/src/render/queryEntity.ts`)
- **A page opened in a hidden tab streamed snapshots to nobody**: `visibilitychange` never fires
  for the initial state, so the render stream stayed enabled until the user first switched away
  and back. The handler is now also applied once at session start. (`apps/web/src/App.tsx`)
- **A malformed snapshot buffer threw through the Worker message listener**: `viewRenderSnapshot`
  failing inside `WorldSession` surfaced as an unattributable page error and took the stream's
  buffer with it. Both snapshot handlers now contain the failure and report it through the same
  error channel the host uses for malformed messages — the client now extends to buffer payloads
  the same discipline the host applies to envelopes. (`apps/web/src/app/WorldSession.ts`)

## 6. Risks examined and found clean

The 26 hostile-review categories, with where each guarantee actually lives:

- **Multiple loops / pause races / speed races** — one nullable handle consumed at iteration
  entry, every start path through `#ensureLoopScheduled`, debt reset on every speed change.
  Attacked with pause/resume storms and speed cycling under a fake clock and in a real browser;
  hashes unmoved, `scheduledCount ≤ 1` throughout.
- **MAX locking the browser / no yielding** — the clock is re-read every tick against a 10 ms
  slice budget, `maxTicksPerSlice` backstops a frozen clock, and MAX reschedules at delay 0. In
  the browser, a pause clicked during MAX landed in well under a second and the tick froze
  exactly.
- **Queue growth / snapshot backlog / JSON high-frequency traffic** — snapshots are pool-bounded
  binary transfers (320 KB each at the default caps, ~1 MB pool ceiling); a dry pool skips the
  frame and advances the cadence clock; telemetry is 2 Hz. Nothing per-organism crosses as JSON,
  ever.
- **requestId handling / stale responses** — monotonic IDs, single-settle pending map, stale
  answers dropped, wrong-type answers reject, `WorldSession` re-checks the selected ID before
  writing the inspector.
- **Detached buffers / transferable ownership / leaks / copies** — one buffer per snapshot, one
  transfer out, one transfer back; both directions verified detached by `structuredClone`
  transfer semantics in tests; self-describing headers refuse foreign, detached or wrong-shape
  buffers on both ends (§3 closed the one counter gap); `EonRenderer.destroy` returns the held
  buffer.
- **Authoritative state on the main thread / React frequency / Pixi churn** — React holds
  metadata, 2 Hz telemetry and one entity's details; the renderer holds one snapshot view and
  pre-built particle pools resized by count, no per-frame allocation; there is no import path
  from `@eon/renderer` to `@eon/engine` (dependency manifests checked, not just imports).
- **Entity queries mutating state** — `findSlotByEntityId` is a Map lookup; `queryEntity` and
  both field writers are pure reads; the projection tests pin the hash across observation, and
  the observed-vs-unobserved 80-tick comparison pins the stronger property.
- **Scheduling changing results** — the whole of §0's layer 1 and 2; nothing moved a hash.
- **Protocol versioning / malformed messages** — strict version equality both directions, typed
  decode with an ERROR answer instead of a throw, malformed traffic injected mid-run in the
  adversarial tests without effect.
- **Worker lifecycle** — DISPOSE stops the loop and refuses resurrection (tested); a replacement
  host reproduces the same world from scratch (tested); `WorldSession.destroy` tears down
  observer, renderer, buffers and worker; the async renderer-create race with destroy is handled.

## 7. Performance observations

On this review's 4-core container with **SwiftShader software GL** — rasterization competes with
the simulation for CPU here in a way it does not on real GPU hardware, so these are floors:

- **1× held 19.9–20.2 TPS** and pause froze the tick exactly, every time, storms included.
- **20× on a young world hits its 400 TPS target** (A10's smoke test; consistent with the ~770
  TPS the first thousand ticks cost headlessly here). On a matured world (past the first
  population boom, thousands of carcasses) this container cannot sustain 400: it ran at ~54 TPS
  **with the `behindTarget` flag shown** — which is the documented contract (docs/02 §8: report
  honestly, never inflate a tick), observed working rather than a defect.
- **MAX at tick 5 132 ran at 80.1 TPS with 1 132 organisms and 3 308 carcasses on screen** —
  consistent with ADR 0010's 75–92 TPS at ~1 280 organisms on the same class of container. During
  the die-off wave at the boom's peak (population 2 048, carcasses climbing), telemetry briefly
  reported sub-1 TPS and recovered unaided; the same deterministic states pass through a headless
  Node run at ~77 TPS average, so the dip is SwiftShader's CPU raster pool starving a 4-core box,
  not the hosting layer. Worth re-measuring on GPU hardware, not worth a code change.
- **The main-thread heap moved −0.5 MB over 30 s of MAX** at high entity counts: no growth, which
  is what "three pooled buffers, particles created once, no per-frame allocation" should look
  like from the outside.
- **Pause round-trip through the full UI was ~0.9 s at MAX under software raster** (rAF ~14 fps —
  the compositor, not the worker: the tick freeze itself was exact in every check). On GPU
  hardware the paint path is not the bottleneck.
- A render snapshot is 320 KB at the default caps (verified from the layout); three buffers bound
  the transport at ~1 MB however long the world runs, and the browser session's zero-growth heap
  corroborates the recycling.
- The selected-entity query, death reporting, resize, reload-as-worker-recreation and the debug
  overlay all worked with **zero console errors and zero page errors** across the ~15-minute
  hostile session.

## 8. Carried forward, unchanged

- The repository's **default branch still points at the Milestone 0–2 feature branch**
  (ADR 0010 §10). Until it points at `main`, the cross-platform determinism matrix gates on the
  wrong branch's pushes and the repo front page shows Milestone 2. Repository-settings change; no
  workflow token can make it.
- **Playwright (L08)** remains unwired; this review's browser validation was again ad-hoc against
  a real Chromium. Two ad-hoc harnesses in two milestones is the argument for L08.
- The foundation-gate and Milestone 2.5 branches remain unmerged (deadline before J05 /
  Milestone 9, unchanged).
- `QUERY_STATE_HASH` with a far-future `targetTick` runs synchronously and unpaced by design
  (determinism verification wants exactly that); a hostile main thread can wedge its own worker
  with it. Documented as accepted: the app never sends it, and the only victim is the sender.
