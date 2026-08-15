# ADR 0020 — Milestone 2.5 world generator (recovered)

> **Recovered in Milestone 11.** This screen was built on
> `claude/milestone-2-5-debug-visualizer-30yxby` (reviewed on `claude/m2-5-review-visualizer-54i8qn`)
> and never merged. The Milestone 9 notes recorded it as "superseded by the M6 renderer + M7 layer
> views it was reused into", which was half right: the layer _views_ of a running world survived
> into the Milestone 7 Layers panel, but the seed-driven generator — type or pick a seed, generate,
> inspect the map it produced — did not, and the only way left to choose a seed was a URL parameter.
> It was found by auditing every remote branch against the trunk and is restored as written, with
> two changes this ADR anticipated: it is mounted as a route (`?view=generator`) rather than as the
> app's only screen, and the one API it used that Milestone 3 removed — the stored plant-gradient
> array — is no longer poked at in its test. Filed as 0020 because it was written as ADR 0004,
> which the surviving line had already used for Milestone 3.

Status: accepted · Date: 2026-08-12 · Engine 0.2.0 (unchanged) · Out-of-band development tool

Milestone 2.5 is not part of the docs/07 Part D roadmap. It exists to make the Milestone 2
environment visible before the renderer milestone: until now the only way to inspect a generated
world was `pnpm headless`, which prints six numbers. A world generator whose output nobody can
look at is a world generator nobody can calibrate.

The brief is explicit that this is a **debug/development tool, not the renderer architecture**.
Everything below follows from taking that literally.

## 1. No version constant changed, and no golden hash moved

`ENGINE_VERSION`, `PROTOCOL_VERSION`, `SNAPSHOT_SCHEMA_VERSION` and `CONFIG_SCHEMA_VERSION` are
untouched. Nothing authoritative changed: no phase, no rule, no config field, no entry in the
canonical hash stream. CLAUDE.md's "UI-only changes must never alter engine hashes" is the whole
test this milestone had to pass, and the existing golden fixture test is the thing that proves it.

The one addition inside `packages/engine` is `hashEnvironment()` — see §4.

## 2. Where the code lives, and why it is split in two

```text
packages/renderer/src/debug/     pure environment → RGBA + aggregate read-outs
apps/web/src/dev/                Canvas 2D, React, seed entry, presets, hover probe
```

The brief asks for a solution that is easy to _delete_ **or** to _reuse later as a debug overlay_.
Those pull in opposite directions, so the code is split along the line where they stop conflicting:

- the **pure part** (layer painter, colour ramps, biome palette, aggregate summary) is in
  `@eon/renderer`, which docs/06 §18 already designates as the home of the development debug
  overlay (task G10). It imports neither Pixi nor the engine nor any DOM API, so it runs in Node
  tests today and can paint into a Pixi data texture in Milestone 6 unchanged;
- the **tool part** (React, canvas, camera, pointer handling, controls) is in `apps/web/src/dev/`
  and can be deleted as one directory.

`@eon/renderer` deliberately did **not** gain a dependency on `@eon/engine`. docs/02 §4 says the
renderer may depend on protocol and shared, never on engine internals. The painter therefore
consumes `EnvironmentDebugFields` — a plain-data view with the player offsets already folded in —
and the adapter that produces it from an `EnvironmentStore` lives in `apps/web`, the composition
root, which is the one place allowed to see both sides.

That view is intentionally **unversioned**. It is the shape a future terrain/overlay message would
carry, but adding it to `@eon/protocol` would start Milestone 6's task G01 and force a
`PROTOCOL_VERSION` bump for a development tool. Debug data is not a wire contract yet.

### Duplicated constants, with a guard

Keeping the renderer engine-free means the debug module carries its own copy of two things: the
biome enum (six names) and `Q = 4096`. A silent copy is a liability, so
`apps/web/src/dev/debugContract.test.ts` — the one place that legitimately imports both packages —
asserts `Q_SCALE === Q`, `DEBUG_BIOME_COUNT === BIOME_COUNT` and
`DEBUG_BIOME_NAMES === BIOME_NAMES`. Divergence fails a test instead of mislabelling a map.

## 3. Canvas 2D, main thread, no worker

Canvas 2D, as the brief allows. A 256² grid is painted into an offscreen canvas at one texel per
cell and blitted with `imageSmoothingEnabled = false`, so a zoomed-in cell is an exact square and
not a blurred interpolation — for a debug view, nearest-neighbour is the _correct_ filter, not the
cheap one.

The engine runs synchronously on the main thread. Generating a world costs on the order of 100 ms
and the tab freezes while it happens; that is stated in the UI rather than hidden. Standing up half
of the Milestone 6 worker host (tasks G01–G04) to avoid a 100 ms freeze in a dev tool is exactly
the "architecture by debug tool" outcome this milestone was told to avoid.

Camera state (zoom, pan) lives in a ref and the canvas is redrawn imperatively, so dragging never
re-renders React. The hovered cell index is React state, but it is written only when the cell under
the pointer actually changes — that is a selection event, which docs/10 §23 explicitly permits in
the React store, not a per-frame stream.

## 4. `hashEnvironment()` — a diagnostic digest, added to the engine

The brief asks the view to display an "environment hash". The engine had no such thing: the
canonical state hash mixes tick, seed, PRNG state and the config digest together with the
environment arrays, so it answers "is this the same world history?" and not "is this the same map?".

`hashEnvironment()` feeds `EnvironmentStore.hashInto()` — the same array order, and therefore the
same versioned contract — under its own magic word (`"EONE"` against the state hash's `"EONH"`), so
the two digests can never be confused. It is a pure read: a test asserts that computing it leaves
the canonical state hash and the tick untouched.

It lives in the engine rather than in the app because it is the engine's own state and the engine's
own hashing contract. Rebuilding the array order in a consumer would create a second definition
that could silently drift from the first.

The view shows both digests plus the config hash, so a world on screen can be matched against
`pnpm headless` output. It does: seed `0xE0A12026` shows state hash `f4940fd92ead5981` in the
browser and in the CLI.

## 5. Layer palettes are documented decisions, not decoration

Seven layers, as asked: elevation, biome, temperature, moisture, fertility, plant capacity, current
biomass. Three choices are worth recording because they change what the tool can prove:

- **The elevation palette breaks exactly at the configured sea level.** The coastline drawn is
  therefore the same threshold `classifyBiome` uses, which makes the water rule visually
  falsifiable rather than merely plausible. A second break sits at the mountain threshold.
- **Temperature uses a fixed −20 °C … +40 °C window**, not a per-world auto-range. Generated worlds
  span roughly −13 °C … +33 °C (ADR 0003 §2), so a fixed window keeps different seeds comparable
  and leaves headroom for a Milestone 9 global offset. The ramp is anchored at 0 °C and at 18 °C,
  the plant capacity optimum of docs/08 §5.
- **Plant capacity and current biomass share one scale**, the highest per-cell capacity in that
  world. Switching between the two layers then shows the vegetation's remaining headroom directly.
  The reference is per-world, so two seeds are _not_ on the same scale — the legend prints the
  number rather than letting the image imply otherwise. Water is drawn blue in both vegetation
  layers, because "0 biomass" would otherwise render an ocean identically to barren desert.

Ramp interpolation is integer arithmetic with truncation toward zero, matching the engine's
rounding policy (ADR 0001 §5). Nothing here is authoritative; the reason is that exact tests beat
approximate ones, and no platform float difference can show up as a pixel difference.

World-derived ramp stops can collide (a world whose mountain threshold sits at 1.0 would place the
rock and snow stops together), so those ramps pass through `compactRamp()`, which merges colliding
stops and keeps the later colour so the extreme of the ramp always survives.

`sampleRamp()` carries no runtime check that its stops ascend. Given ascending stops the segment
search provably lands on a positive span, so such a check would be unreachable code in a per-pixel
loop; the invariant is asserted by `isAscendingRamp()` over the ramps the package actually ships.

## 6. A time control, which the brief did not ask for

Two buttons advance the world by 1 000 and 10 000 ticks. This is the one addition beyond the listed
requirements, and the reason is that without it the "current biomass" layer is empty of information:
at tick 0 every cell holds exactly `initialBiomassFractionQ` (50%) of its capacity, so the layer is
a scaled copy of the capacity layer and the requirement would be met in form only. After 10 000
ticks the fixture world reaches 99.3% of capacity, and logistic saturation becomes something you
can see.

It calls `stepMany()` and nothing else — no rate, cadence or rule is reimplemented — and it is not
a time-control feature: no pause, no speed, no scheduler. Those are Milestone 6 (task H02).

## 7. Preset seeds, and how they are kept honest

Six presets, each chosen to reach a different corner of world generation: the golden fixture seed,
the most productive world in a 22-seed survey, a near-minimum-land archipelago, an unusually
mountainous world, a world missing a biome class, and one whose first generation attempt is
_rejected_ so the deterministic retry path (ADR 0003 §5) is reachable from the UI.

Preset notes describe worlds, and a generation change could make a note false. `presetSeeds.test.ts`
therefore asserts the structural claims: every preset produces a valid world, and the retry preset
really does report `generationAttempt > 0`. If generation changes, the test fails and the preset is
re-picked — a debug tool must not describe a world it is not showing.

## 8. Seed parsing is strict, for the reason the CLI's is

`parseSeedInput()` rejects `"100abc"`, `"1.5"`, `"-1"` and anything above `0xFFFFFFFF` instead of
coercing them. `Number.parseInt` would turn the first two into 100 and 1, and `seed >>> 0` maps
distinct out-of-range inputs onto one world — the same defect ADR 0002 §6 fixed in the headless CLI,
and it matters more here because the field is the primary control.

## 9. React purity, and the initial world

The first world is generated in a `useState` initializer, not in an effect. Generating in an effect
means `setState` during mount (cascading renders, and a lint error from the React hooks rules);
generating in the initializer is sound precisely _because_ of the determinism contract — world
generation is a pure function of (seed, config), so StrictMode's double invocation produces the
identical world and simply discards one engine.

The engine handle is held in React state alongside the immutable read-out that describes it. React
never reads a field off the engine during render: every value on screen comes from
`DebugWorldModel`, which is rebuilt explicitly and only when the world changes. That is the
substance of docs/10 §2's "do not expose stores to React" — the store is an opaque handle here, not
a reactive data source.

Wall-clock read-outs were dropped from the UI. `performance.now()` inside a component is an impure
call that the hooks lint correctly rejects, and timing belongs to `pnpm headless` and the future
benchmark CLI (task L01) rather than to a map viewer.

## 10. Playwright deliberately not added

CLAUDE.md's toolchain policy adds Playwright "when the first interactive vertical slice exists".
This view is interactive, so the question is live. It is deferred on purpose: the product's
interactive slice is Milestone 6 (tasks G02–G09, acceptance in docs/07), task L08 owns the
Playwright flows, and adding a browser-downloading dependency to CI for a tool that is meant to be
deletable is the wrong trade. The view was instead verified manually in headless Chromium — every
layer, pan, zoom, hover, all six presets, a typed seed, the retry path, 10 000 ticks and the
invalid-seed path — and the pure transformations are covered by Node tests.

## 11. Explicitly not done

No organisms. No worker, protocol message or scheduler. No Pixi. No LOD, camera package, selection
or overlay architecture from Milestone 6. No persistence. No player interventions — the
`*Offset*` arrays are read and displayed, but nothing writes them.

## 12. Review amendments (M2.5 review gate)

The milestone was reviewed against six questions: does the debug renderer mutate engine state, did
colour/mapping logic leak into the engine, does React hold authoritative arrays in a way that causes
needless re-renders, does switching a layer regenerate the world, do the seed and hashes describe the
state actually on screen, and does any of this force a bad Milestone 6 architecture. Four came back
clean; two produced fixes. No version constant and no golden hash moved — the review changed
presentation code and one preset note only.

### 12.1 Verified clean

- **No engine mutation.** `captureEnvironmentDebugFields()` copies every array
  (`new Uint16Array(...)`) and folds the offsets through the store's own accessors;
  `hashEnvironment()` is a pure read. Tests assert both leave `tick` and the canonical state hash
  untouched, and that an old capture does not change when the world is advanced.
- **No colour logic in the engine.** `grep -niE "colou?r|rgb|pixel|palette|canvas|css"` over
  `packages/engine/src` returns nothing. The engine's one M2.5 addition is `hashEnvironment()`.
- **Layer switching does not regenerate anything.** Confirmed in a headless Chromium run: changing
  the layer repaints the offscreen image from the same captured fields, leaves the world state hash
  at `f4940fd92ead5981` and leaves the camera where it was.
- **The read-outs describe the world on screen.** The browser shows state hash
  `f4940fd92ead5981` and config hash `e47244ab51c06af3` for seed `0xE0A12026`, identical to
  `pnpm headless`, and the hover probe on cell 16 512 reports Grassland / 0.739 / 2.95 °C / 0.133 /
  0.239 / 410 / 205 — value for value what the engine holds for that cell.

### 12.2 Fixed: advancing time threw the camera away

`EnvironmentFieldCanvas` recentred whenever its `fields` prop changed identity. That is right for a
new seed and wrong for `+1 000 ticks`, which re-reads the _same_ map into fresh arrays: zooming into
a valley and watching it grow was impossible, because every advance snapped back to the whole world.

`DebugWorldModel` now carries `worldKey` — seed, generation attempt and grid size, deliberately not
the tick — and the camera resets on that or on the explicit recenter token. The behaviour is pinned
from both sides: unit tests assert the key survives an advance and differs between seeds, and the
browser check confirms the camera survives `+1 000 ticks`, still recentres on a new seed, and still
obeys the Recenter button.

### 12.3 Fixed: a hover re-rendered the whole tool

The hovered cell is React state in `EnvironmentDebugView`, so every cell the pointer crossed
re-rendered the map component, the legend (which rebuilds its entries on each call) and the
forty-odd rows of world read-out — none of which depend on the pointer. It is not the failure
docs/10 §23 warns about (no array is copied into state; the model is rebuilt only when the world
changes), but it is the same waste one level down.

The map, the legend and the world read-out are now memoized children keyed on the world, leaving the
eight-row hovered-cell panel as the only thing a hover rebuilds. Measured over 200 hovered-cell
changes, interleaving both builds in one Chromium session: script time 82.8 ms → 65.2 ms median
(five runs each, worst case 110 → 89). Layout time is unchanged at ≈41 ms — that is the hover panel's
own DOM updates plus one `getBoundingClientRect()` per pointer move, and it is the cost of the
feature rather than of the implementation.

### 12.4 Fixed: a preset note described a world it was not showing

The golden-fixture preset claimed "all six biome classes". True only in the sense that three cells
out of 65 536 are forest — invisible at any zoom. §7 sets the standard that a debug tool must not
describe a world it is not showing, so the note now says forest survives on a handful of cells and
the map reads as five classes, and `presetSeeds.test.ts` pins both halves of that claim. The
no-desert preset's claim gained a test too. The `pnpm headless` sample in `README.md` was also
missing the `Forest=0.0%` column the CLI actually prints.

### 12.5 Camera arithmetic extracted and tested

The fixes above needed the camera to be inspectable, and it was buried in a component that no Node
test can reach. `apps/web/src/dev/debugCamera.ts` now holds it as pure functions over a plain
record — fit zoom, centring, clamping, panning, zoom about a point, cell hit-testing, visible
gridline range — with 17 tests. `EnvironmentFieldCanvas` is left with blitting, canvas overlays and
pointer plumbing. This is also the part a Milestone 6 camera would supersede, so it is now separable
rather than entangled with the tool.

### 12.6 Fixed in the foundation: the headless summary described the wrong tick

Not part of this milestone's diff, but §4 and `README.md` both make `pnpm headless` the ground truth
the view is checked against, and its `plants` line was printed straight after generation — so
`--ticks 10000` reported tick-0 biomass (50.0% of capacity) under a `ticks 10000` header. The run's
own totals are now printed after it (`plants @10000 … 99.3% of capacity`), which is also the first
time §6's 99.3% claim is checkable from the CLI. No hash and no engine code changed.

### 12.7 Accepted, not fixed

- `apps/web/package.json` still lists `@eon/protocol`, which nothing imports since the old shell
  screen went away. It returns as a real dependency in Milestone 6 (task G01); removing and
  re-adding it would be churn.
- `@eon/renderer`'s package root re-exports the debug surface alongside its own. A `./debug` subpath
  export would separate them more cleanly; it is worth doing when the package gains a real Pixi API
  in Milestone 6, not before.
- `EnvironmentDebugFields` still lives in `@eon/renderer` and is still unversioned (§2). When the
  terrain overlay becomes a worker message it must move to `@eon/protocol`, or the dependency
  direction of docs/02 §4 inverts. Recorded here so Milestone 6 does not inherit it by accident.
- The page has no favicon, so a browser logs one 404 on load. Cosmetic.
