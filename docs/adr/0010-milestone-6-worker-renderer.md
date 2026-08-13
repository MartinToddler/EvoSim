# ADR 0010 — Milestone 6: Worker host, render transport and PixiJS renderer

Status: accepted · Date: 2026-08-13 · Engine 0.5.0 (unchanged) · Protocol 1 → 2 · Tasks G01–G10

Milestone 6 is the first one that produces something to look at. The authoritative simulation
moves off the main thread into a dedicated Worker, render state crosses back as packed
transferable buffers, and a PixiJS renderer projects it onto a canvas with a camera, selection
and the minimum controls needed to drive a world.

Nothing about the simulation changes. **`ENGINE_VERSION` stays 0.5.0 and every golden hash is
byte-identical**, which is the point: CLAUDE.md requires that UI-only changes never move an
engine hash, and this milestone is entirely projection and hosting.

## 0. Branch state this milestone was built on

Milestone 6 continues the Milestone 3/4/5 line and was developed on top of `ef11200`
("Milestone 5 review"). The two side branches noted in ADR 0006 §0 and ADR 0008 §0 are **still
not merged**:

- the Milestone 0–2 foundation-gate branch (`73adfa7`), and
- the Milestone 2.5 debug environment view (`1083172`).

Nothing here depends on either, and the merge deadline recorded by the previous two gates —
before **J05 / Milestone 9** (terrain raise/lower) — is unchanged. One deliberate concession to
the eventual merge: `packages/renderer/src/palette.ts` reuses the Milestone 2.5 branch's biome
colours _exactly_, so the debug view and the world view agree about what a desert looks like and
the merge is a textual conflict rather than a visual one.

## 1. Where the scheduler lives, and why it takes its clock as an argument

`SimulationHost` owns the engine and decides when it steps. It never decides what a step does.
The three browser capabilities it genuinely needs — a clock, a scheduler and a message port —
are constructor parameters, and `simulation.worker.ts` is a 50-line file that supplies
`performance.now`, `setTimeout` and `postMessage` and nothing else.

This is not abstraction for its own sake. Every interesting bug in a simulation host is a timing
bug: two loops running at once, a pause that races a slice, a backgrounded tab that resumes
owing ten thousand ticks, a snapshot backlog that grows without bound. Against a real clock those
are irreproducible; against an injected one they are ordinary unit tests. `SimulationHost.test.ts`
runs 41 of them, including "pause for sixty seconds and resume" — instantly and exactly.

### The scheduling model

Wall-clock time decides **how many** ticks are due, never what a tick does:

```text
paused  no loop scheduled at all
1x      20 ticks/s      5x  100      20x  400      100x  2000
MAX     unpaced: run until the slice budget expires, then yield with delay 0
```

Three bounds keep it honest:

- **Slice budget** (`maxWorkerSliceMs`, 10 ms) ends a slice so the Worker returns to its event
  loop and handles queued messages. At MAX the clock is re-read every tick rather than every N,
  so pause latency does not scale with population.
- **Catch-up cap** (`maxCatchUpTicks`, 200) bounds the tick debt. A tab hidden for a minute must
  not come back and sprint through 1200 ticks; it resumes where it is and reports
  `behindTarget`.
- **Tick cap per slice** (`maxTicksPerSlice`, 2048) is the backstop for a clock too coarse to
  advance inside a slice. Without it a purely time-based loop never terminates — which is not
  hypothetical, it is what a fake clock does, and a coarse real one can do the same.

**Tick debt resets on every speed change, including pause and resume.** Wall-clock time that
passed while a speed was not in effect must not be billed to it; without the reset, 1× debt gets
repaid at 100× and every speed change produces a visible burst.

### One loop, guaranteed

A single field — the handle of the one scheduled iteration — is the whole guarantee. Every path
that could start the loop goes through `ensureLoopScheduled`, which returns immediately if a
handle exists. Twenty-five resume messages produce one loop, and a test asserts exactly that.

## 2. Render transport: one buffer, one transfer, recycled

A render snapshot is the only high-frequency message in the system, so its cost is the system's
cost. The layout follows from three constraints (docs/02 §10):

1. **No JSON.** Every per-entity field is a TypedArray element.
2. **One transfer.** Seventeen parallel arrays would be seventeen `ArrayBuffer`s to neuter and
   reattach per frame. Instead every column is a view into a single buffer, so a snapshot is one
   transfer and one recycle.
3. **Bounded allocation.** A `RenderBufferPool` of three buffers is refilled forever. When the
   renderer holds them all, `acquire()` returns `null` and the snapshot is **skipped**.

That last point is the milestone's sharpest rule: **render snapshots are droppable,
authoritative ticks are not**. Back-pressure on the picture must never become back-pressure on
the simulation, and the simulation must never be "helped" by a bigger tick.

At the default caps (8192 organisms, 4096 carcasses) a snapshot is ~328 KB; three of them are
about a megabyte, transferred rather than copied.

Buffers are self-describing — magic, layout version, capacities, counts, tick — because they
travel by transfer and come back through a recycle message. A detached, foreign or wrong-shaped
buffer is rejected rather than pooled; the alternative is a renderer quietly reading garbage.

The header's tick is a `Float64`, not a `uint32`: engine 0.1.1 already fixed the assumption that
a tick fits in 32 bits, and the wire format must not reintroduce it.

### Two fields, two rates

Terrain (biome + elevation) is sent once with `WORLD_READY`. Vegetation streams on its own
~4 Hz pool, because plant biomass only changes when the environment phase runs and a 64 KB field
at frame rate would cost more bandwidth than every organism in the world combined (docs/06 §2).

## 3. The engine projects; it does not know what a pixel is

`writeRenderSnapshot(engine, writer)` fills caller-owned TypedArrays. It allocates nothing,
advances no tick, touches no PRNG and writes to no engine array. The parameter is a structural
interface of plain arrays, so `@eon/engine` does not import `@eon/protocol` and
`@eon/protocol` does not import `@eon/engine`; the packed layout satisfies the writer shape
structurally.

Colour is **not** decided in the engine. It emits the hue _gene_ in degrees and a biome _index_;
the renderer owns the palette, because choosing an RGB triple is presentation policy. The
renderer converts through a 360-entry lookup table rather than an HSV conversion per organism per
frame.

The purity claim is tested two ways: the state hash is unchanged across repeated snapshots and
queries, and — stronger — a world observed between every tick and a world never observed produce
the same hash after 80 ticks.

## 4. Profiling without a clock in the engine

CLAUDE.md requires per-phase instrumentation from the first vertical slice, and in the same
document forbids the engine from reading a wall clock. Both rules are right and they are not in
conflict: the engine knows _where_ the phase boundaries are and the host knows _what time it is_.

`SimulationEngine.step()` calls an optional `TickProfiler` at each boundary. A profiler receives
two integers and returns nothing, so there is no channel through which a clock reading could
reach authoritative state — and a test runs a profiled world beside an unprofiled one and
requires the same hash.

The host samples one tick in 32. At MAX a world executes thousands of ticks a second, and timing
every boundary of every tick would measure the observer instead of the system. The reported
number is therefore mean milliseconds per _sampled_ tick.

## 5. Renderer decisions

- **`ParticleContainer`**, one for organisms and one for carcasses, with every `Particle` created
  at startup and updated in place (docs/10 §24). Drawn count follows population by resizing
  `particleChildren` against a pre-built pool, so nothing is allocated per frame.
- **A minimum on-screen radius of 1.6 px.** At full-world zoom a 2 LU animal is about one pixel
  across. docs/06 §3 puts that in LOD 0 — "point, tint only" — and this constant is what makes
  such a point actually visible. It exaggerates size when zoomed out; that is the intended trade,
  and it affects nothing but pixels.
- **A pooled detail layer** above a 7 px screen-radius threshold, capped by
  `maxDetailedRenderedOrganisms` (250) so its cost cannot grow with population. The selected
  organism is promoted first whatever its size.
- **The selection ring is drawn in screen space**, as a child of the stage rather than of the
  camera-transformed world layer. Drawn in world space it is tessellated at world scale, and a
  ring two location units across becomes a visible hexagon exactly when the camera is zoomed in
  far enough to be worth looking at. This was caught by the browser smoke test, not by a unit
  test.
- **Selection is a linear scan**, not Pixi interaction. docs/06 §6 forbids thousands of event
  handlers; 8192 distance comparisons on a human click is microseconds. Ties break on lowest
  entity ID, because storage order changes as slots are reused and an order-dependent pick would
  select different animals from the same spot over time.
- **`@eon/renderer` depends on `@eon/protocol` and nothing else** in the workspace. There is no
  import path from the renderer to the engine, so a rendering change cannot reach simulation
  state (docs/02 §4). The cost is a second copy of the six biome names, which a palette test
  pins.

## 6. React holds no organism

React state is world metadata, 2 Hz telemetry, the selected entity ID and its details — exactly
the list docs/10 §23 marks safe. A world of 8192 organisms therefore causes the same number of
React renders as an empty one: two per second.

The canvas is created imperatively by the session effect and removed on cleanup rather than being
a JSX element. That keeps Pixi's WebGL context and React's reconciler apart, and makes
StrictMode's deliberate double mount harmless instead of a source of two sessions sharing one
canvas.

## 7. Version decisions

- **`PROTOCOL_VERSION` 1 → 2.** Version 1 was an envelope type with no message union and no
  consumer; this is the first version an actual Worker speaks.
- **`HOST_RUNTIME_CONFIG_SCHEMA_VERSION` 1 → 2**, adding vegetation/telemetry cadence, the
  catch-up and slice bounds, and the render pool size. None of it is authoritative, which is
  precisely why it lives in `@eon/protocol` and not in `SimulationConfig` (ADR 0002 §4) — a
  render cadence must never move a world hash.
- **`ENGINE_VERSION` unchanged at 0.5.0**, and no golden hash regenerated. The engine gained
  read-only projections and optional profiling hooks; it gained no behaviour.

## 8. Determinism acceptance

The required property is that a world executed through the Worker's scheduler and the same world
executed headlessly in Node reach the same canonical hash at the same tick. Two tests assert it:

1. A straightforward run: the host at 20× for 600 ms of simulated wall clock reaches tick 240 and
   hashes identically to `new SimulationEngine(...).stepMany(240)`.
2. A deliberately erratic one: five speed changes, three pauses, a MAX burst, render snapshots
   and entity queries interleaved, then `QUERY_STATE_HASH` to top the world up to tick 2000 —
   identical to 2000 uninterrupted steps.

The second is the real test. It says that pausing, resuming, changing speed, dropping snapshots
and inspecting organisms are all invisible to the simulation.

Both run on a 64² world, because a unit test should not cost minutes. `pnpm equivalence` runs the
same comparison on the **real default world** — seed `0xE0A12026`, `DEFAULT_CONFIG`, the world the
golden fixture describes and the browser opens — and adds the third term:

```text
target tick 10000
ticks executed by the scheduler   9820
ticks topped up through the port  180

worker   hash @ 10000  f58bac3bde3256f3
headless hash @ 10000  f58bac3bde3256f3
golden   hash @ 10000  f58bac3bde3256f3
```

9 820 of the 10 000 ticks were produced by the Worker's own loop, through a pause of thirty
simulated seconds, four speed changes, an entity query and a suspended render stream — and the
result is the hash that was committed to the fixture before any of this code existed.

## 9. Explicitly not done

- **No player commands.** docs/02 §13 lists `QUEUE_COMMAND`, and the engine has no
  `applyCommand` — commands are Milestone 9. Declaring the wire shape now would mean inventing
  payloads for rules nobody has written, so `LOAD_WORLD`, `QUEUE_COMMAND`, `QUERY_SPECIES`,
  `REQUEST_TREE`, `REQUEST_HISTORY_RANGE`, `REQUEST_SAVE`, `REQUEST_REWIND` and `CREATE_BRANCH`
  arrive with their milestones and bump the protocol version then.
- **No Milestone 7 UI.** The top bar and the selection readout are the controls M6 needs to be
  drivable. No inspector gene bars, no charts, no timeline, no tree, no tools.
- **No Playwright suite (L08).** The browser smoke test that verified this milestone was run
  ad-hoc against a real Chromium; wiring Playwright into the repository is section L work and
  would have pulled a test-infrastructure decision into a rendering milestone.
- **No viewport culling.** All live organisms are updated and submitted every frame. At the 8192
  cap that is not a measured hotspot, and CLAUDE.md says to optimize measured hotspots only.
- **No `SharedArrayBuffer`.** docs/02 §10 rules it out for MVP; it would also require
  cross-origin isolation headers that GitHub Pages does not send.

## 10. Deployment

There was no deployment before this milestone, and no preview infrastructure to protect. The new
`deploy-pages` workflow publishes `apps/web/dist` to GitHub Pages, enabling Pages on first run,
and gates on `pnpm typecheck && pnpm lint` (the full suite runs in parallel in `verify`, where it
takes twenty times as long).

`base` is a build-time environment variable because the same bundle must work from `/` under
`vite dev` and from `/<repo>/` on a project site. A wrong base is silent at build time and fatal
at run time: every asset, the Worker included, 404s.

The workflow triggers on the milestone branch as well as `main`, because `main` still carries
only the Milestone 0–1 skeleton and restricting it to `main` today would publish an empty page.
**Once this work is merged, drop the branch pattern** so `main` is the only source of the
published site.
