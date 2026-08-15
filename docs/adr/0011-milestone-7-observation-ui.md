# ADR 0011 — Milestone 7: Observation UI

Status: accepted · Date: 2026-08-14 · Tasks: H01–H06 (docs/06 §§7–9, 11, 15–17; docs/05 §§10–11)

Versions: `ENGINE_VERSION` **unchanged at 0.5.0**, `PROTOCOL_VERSION` 2 → **3**,
`FIELD_SNAPSHOT_LAYOUT_VERSION` 1 → **2**, `HOST_RUNTIME_CONFIG_SCHEMA_VERSION` unchanged (2),
`CONFIG_SCHEMA_VERSION`/`SNAPSHOT_SCHEMA_VERSION` unchanged (6/6). **No golden hash changed.**

## 1. World layers ride the terrain snapshot, not a new request protocol

docs/06 §7 requires ecological heatmaps but no document specifies a wire shape for them, and
ADR 0010 §9's policy is not to invent message types ahead of their rules. The layers M7 needs —
temperature, moisture, fertility, plant capacity — are **static until the Milestone 9
interventions**, which will already have to resend edited fields (the plan recorded in
`terrainSnapshot.ts` since M6). So the terrain snapshot simply grew four byte-per-cell display
planes (layout version 2) and still travels once, inside WORLD_READY. No new message, no request
correlation, no cadence question; 256² × 4 = 256 KB, paid one time.

Consequences that fall out of this choice:

- **Switching layers is renderer-local.** All planes are on the main thread before the first frame,
  so the layer picker recombines local arrays into the terrain texture. There is no code path from
  a layer switch to the Worker — the H05 requirement ("switching must not perturb the simulation")
  is true by construction and pinned by a session test that counts posted messages.
- **Plant biomass reuses the existing ~4 Hz vegetation stream**; the density layer is derived on
  the main thread from render snapshots already in hand (one pass per snapshot, only while active).
  Population density therefore costs nothing when nobody looks at it (docs/06 §7's "one heavy
  overlay at a time").
- **Quantization ranges are published, not duplicated.** The engine exports the temperature display
  range and the capacity reference; the host copies them into `WorldSummaryDto.display`; the legend
  reads the DTO. Writer and legend cannot disagree because there is one source.

Ramps are renderer palette policy (`palette.ts`), like every other colour: sequential layers run
dark → bright in a single hue (dark recedes into the dark canvas), temperature — the one field
with real polarity — is a cool/warm diverging ramp through a neutral midpoint, and biomes stay the
categorical palette. A data layer blends over the composed terrain at a user-controlled opacity so
coastlines stay legible under the data.

## 2. Chart data: engine aggregates once, the main thread accumulates in tiers

The engine has no statistics store yet (docs/10 lists one; nothing consumes
`time.statisticsInterval` so far), and streaming per-organism arrays to draw charts is forbidden
(docs/06 §15). The M7 answer stays inside the existing telemetry pipe:

- `collectTelemetryAggregates` — already a single ascending pass at 2 Hz — now also computes
  population **trait means** (diet, speed, radius, vision, attack, armor, pace, thermal optimum),
  total organism mass and mean energy fraction. A fixed handful of scalars per frame; the React
  render count stays two per second whatever the population (ADR 0010 §6).
- The main thread accumulates telemetry into `StatsHistory` (`@eon/ui`), the docs/05 §11
  multiresolution buffer: fine samples promote, `aggregationFactor` at a time, into coarser tiers
  as tiers overflow — levels take group means, cumulative counters take the group's last value.
  Recent history is raw, old history coarsens geometrically, the whole run stays on the chart, and
  retention is a hard `bucketsPerTier × maxTiers` bound (the coarsest tier self-compacts if a run
  outlives it).
- **The x-axis is the authoritative tick, never the sample index.** Telemetry is wall-clock paced:
  one sample spans 10 ticks at 1× and thousands at MAX. Births/deaths are plotted as rates derived
  from the cumulative counters between samples, so the same chart is meaningful at every speed.
  Samples whose tick did not advance (paused re-reports) are skipped, not plotted as duplicates.

A note for the record: the first implementation halved the whole buffer pairwise when full. A test
demanding "the oldest retained sample is still early in the run" caught it collapsing all history
into one late-stamped bucket — uniform re-merging degenerates into "ancient point + recent window".
The tiered scheme (merge a bucket **once**, at promotion) is not just the documented shape, it is
the correct one.

## 3. Inspector: costs are recomputed, the brain view is read, never re-inferred

docs/06 §11 asks for a cost breakdown and a debug-style brain section. Neither is stored per
organism — metabolism has no reason to remember a breakdown 8 192 rows wide for the one organism
somebody clicked. `queryEntity` therefore:

- **recomputes the basal and movement costs read-only**, from the same formulas and the same
  scratch effort fractions (`speedFractionQ`, `accelFractionQ`, `inWater`) the physiology phase
  bills, plus the thermal multiplier and floor — so the inspector shows the number the organism is
  actually paying this tick;
- **reads the retained sensor block and mapped intents from `EngineScratch`** — what the last tick
  actually sensed and decided. Nothing is re-inferred, no PRNG is touched, and before the first
  tick the values are honestly zero. The 400 raw weights are deliberately not exposed anywhere
  (the task brief and docs/06 §11 agree a weight dump is not an inspector).

Label lists (brain inputs, intents, death causes) are engine constants copied into
`WorldSummaryDto.display` by the host — the one module that legitimately imports both packages —
so `@eon/ui` needs no engine dependency and no duplicated string tables.

## 4. Follow lives in the renderer's frame loop, with explicit endings

Follow re-centres the camera each frame from the newest snapshot (the same lookup the selection
ring already does). It ends four ways, all explicit: `cleared` (button), `selection` (selected
something else), `user` (dragged the camera — follow must yield or the next frame snaps back), and
`died` (target absent from a snapshot). The paused-world death — where no new snapshot will ever
arrive — is caught by the inspector's query answering `null` and ends the follow through the same
path. The UI is told the reason; the inspector shows the death honestly and keeps the last known
values on screen.

## 5. DTOs are frozen at the session boundary

"UI cannot mutate authoritative state" was a convention enforced by types; M7 makes it a runtime
fact. `WorldSession` deep-freezes every DTO (world summary, telemetry, entity details) before its
callbacks run, so any write attempt from UI code throws in strict mode. The cost is a few
`Object.freeze` calls per second on small objects. The session tests assert frozenness; the
`StatsHistory` tests prove the charts read frozen telemetry without needing to copy it.

## 6. `@eon/ui` becomes a real package

Per the docs/10 §1 blueprint, the M6 components moved out of `apps/web` into `@eon/ui` (top bar,
inspector, layers panel, stats panel, charts). Its workspace dependencies are `@eon/protocol` and
`@eon/renderer` — the latter **only via the new `@eon/renderer/palette` subpath**, which exports
pure colour policy without touching `pixi.js`, so UI tests run in plain Node and the app's
dependency graph stays acyclic. React-hooks linting now covers `packages/ui` alongside `apps/web`.
Panel rendering is tested with `renderToStaticMarkup` (components are pure functions of DTO
props); wiring is tested through `WorldSession` with injected worker/renderer fakes — the two
browser-bound edges became constructor seams rather than hard-wired globals.

## 7. Placeholders that refuse to lie

- **Species count** shows an em dash with "arrives with Milestone 8" — the registry does not exist
  and `speciesId` is still the founder constant, so any number would be an invention.
- **Save state** (docs/06 §9) is absent entirely; persistence is Milestone 10.
- **Population cap warning** (docs/01 §11) needs no event system: `capRejectedBirths` is already in
  telemetry, so the population figure itself turns amber with an explanatory title the moment the
  cap distorts evolution.

## 8. Review findings and their fates

An adversarial multi-lens review of the milestone diff surfaced eight candidate defects; four were
real and are fixed in this milestone:

- **Stale scratch shown for newborns.** `queryEntity`'s brain/cost view reads retained scratch; a
  newborn in a reused slot showed its predecessor's last sensors and intents until its first full
  tick — indefinitely, on a paused world. `spawnOrganism` now clears the slot's scratch blocks
  (authoritatively redundant — every value is rewritten before the engine reads it — so no hash
  moves; a regression test pins the honest-blank-brain contract).
- **`thermalStress` misdocumented.** The engine's stress scale is 0..2Q with damage starting at Q;
  the DTO claimed [0, 1]. The value is now normalized to the worst case, making 0.5 exactly the
  damage threshold the docs describe.
- **Speed-button flicker.** The UI synced its speed state from telemetry, so a frame produced just
  before a speed change was processed flicked the buttons back for half a second. The UI now shows
  the last _requested_ speed; the host honours it or errors.
- **Hardening:** `writeTerrainFields` bounds its loop by every plane, and a non-finite layer
  opacity is rejected instead of blending the map to black.

Two were judged not defects: `followSelected` on an entity that just died self-corrects through
`onFollowEnd` on the next frame (and the UI hides the button for dead organisms), and the
follow-camera's per-frame linear entity scan is the same access pattern the selection ring has used
since M6 — thousands of integer compares per frame, far below the particle update cost it
accompanies. Two documentation complaints dissolved with the fixes above.

## 9. Explicitly not done

No timeline, no tree, no species inspector (M8); no tool palette (M9); no Playwright suite (L08 —
the manual browser pass is recorded in the changelog); no brain-weight dump; no per-organism
overlays (vision cones etc., docs/06 §18) — those need per-organism data the render snapshot
deliberately does not carry.
