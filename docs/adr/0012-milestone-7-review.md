# ADR 0012 — Milestone 7 review: observation UI

Status: accepted · Date: 2026-08-14 · Engine 0.5.0 (unchanged) · Review of tasks H01–H06

Independent review of the observation UI: `App.tsx` and `WorldSession.ts`, the `@eon/ui` panels
and charts, the renderer's world layers, follow camera and pointer input, `queryEntity`'s cost and
brain views, the seven-plane terrain snapshot, and the telemetry extensions — against the
eighteen-point review brief (placeholder honesty, the React boundary, telemetry cadence, chart
memory, stale queries, entity death, follow, slot vs entity ID, pause/play, speed switching, layer
purity, query purity, resize, mobile layout, gestures, listener and chart leaks, Pixi lifetime,
accessibility).

**Four defects were found and fixed (all P2), plus three P3 polish issues.** Every one is
presentation-side — renderer input handling, a stylesheet rule, panel state in the app shell, and
tooltip/ARIA details in `@eon/ui`. **No engine, protocol or worker file changed: `ENGINE_VERSION`
stays 0.5.0, `PROTOCOL_VERSION` stays 3, and every golden hash is untouched by construction**,
which `pnpm verify` re-confirmed on this exact tree.

## 0. Method

The milestone's claims were treated as claims. The wiring was re-read from
`WorldSession`/`WorkerClient`/`SimulationHost` source rather than from ADR 0011; the purity claims
were checked against the engine's own tests (`queryEntity`/`collectTelemetryAggregates`/
`writeTerrainFields` leave the state hash untouched; a newborn in a reused slot shows a blank
brain); and the behaviors no Node test can reach were exercised in a real headless Chromium
against the dev server with a scripted pass — boot to WORLD_READY, exact pause, resume, rapid
speed flips, a sweep across all nine layers, chart accumulation, click-selection at the founder
region, follow engage/drag-release, a three-finger pinch, sheet exclusivity across a live viewport
resize, and console/page error capture. The script's gesture case was written to _fail_ on the
shipped code (it did) and pass after the fix (25/25 checks green).

| Review item                       | Result                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Values real, placeholders honest  | **Pass.** Every number traces to telemetry, `queryEntity` or WORLD_READY; species shows an explained em dash; the cap warning reads `capRejectedBirths`. One tooltip lied — §4.     |
| React never owns simulation state | **Pass.** React holds DTO scalars at 2 Hz; DTOs are deep-frozen at the session boundary (test-pinned); the canvas is imperative; no organism coordinate enters React state.         |
| Telemetry frequency               | **Pass.** 2 Hz host cadence; the inspector refreshes with telemetry, not per frame; chart memoization keys on the tick.                                                             |
| Bounded chart memory              | **Pass.** `StatsHistory` holds ≤ `bucketsPerTier × maxTiers` samples; promotion merges once; the coarsest tier self-compacts; bounding and ascending-tick tests exist.              |
| Stale entity requests             | **Pass.** Dropped twice: the client's pending map and the session's selection check; a stale answer for a re-selected entity is overwritten by the later in-order answer.           |
| Entity death                      | **Pass.** Inspector says "gone" and freezes last values; follow ends by snapshot absence (running) or query-null (paused); both paths test-pinned.                                  |
| Follow mode                       | **Pass.** Four explicit endings; snap-on-start; `fitWorld` yields the camera. Drag-release re-verified in the browser.                                                              |
| Slot vs entity ID                 | **Pass.** Snapshots are dense projections keyed by entity ID; picking tie-breaks on lowest ID; the engine resolves queries by ID with a liveness check; newborn scratch is cleared. |
| Pause/play                        | **Pass.** Tick debt resets on every speed change; pause stops the loop and emits telemetry at once; browser confirmed an exact freeze and resume.                                   |
| Rapid speed switching             | **Pass.** One loop handle ever exists; the UI shows the last requested speed; a five-flip browser sequence ran clean.                                                               |
| Layer switching purity            | **Pass.** No code path from a layer switch to the Worker; a session test counts posted messages; a nine-layer browser sweep left the tick stream and console clean.                 |
| Entity queries consume no RNG     | **Pass.** `queryEntity` recomputes costs through pure functions and reads retained scratch; engine tests pin "state hash untouched"; M6's observed-vs-unobserved test still stands. |
| Resize                            | **Pass.** ResizeObserver → renderer resize → camera clamp; observer disconnected on destroy; browser confirmed the canvas tracks the viewport. One rule broke on resize — §3.       |
| Mobile/tablet layout              | **Pass** after §3: safe-area insets, ≥44 px coarse targets, bottom sheets, sideways stat strip.                                                                                     |
| Gesture conflicts                 | **Fail → fixed.** §1 and §2: a third finger mid-pinch fired a click selection, and a pinch ending with one finger down left it dead. Chart touch rules also blocked the sheet — §2. |
| Listener leaks                    | **Pass.** Every add/remove is paired (visibility, keydown, matchMedia, canvas pointers, ticker, ResizeObserver); teardown is idempotent and test-pinned. One timer leaked — §4.     |
| Chart leaks                       | **Pass.** SVG only, no RAF, no retained DOM; history is bounded and cleared on WORLD_READY.                                                                                         |
| Pixi rerenders/remounts           | **Pass.** One Application per session on an imperatively owned canvas; StrictMode's double-mount produces two clean create/destroy cycles; pools are preallocated and reused.       |
| Accessibility basics              | **Pass** after §4: labelled controls, `aria-pressed` on toggles, charts as `role="img"` with numeric summaries, meters always paired with numbers, Esc deselects, focus-visible.    |

**Which of these are now permanent tests.** The derived speed tooltip and the radio-ARIA shape are
pinned in `panels.test.tsx`. The gesture fixes live in `EonRenderer`'s pointer handlers, which no
Node test can exercise — they were verified in the scripted browser pass recorded here, as M6's
renderer was; the Playwright suite proper remains task L08.

## 1. Defect (P2): a third finger during a pinch fired a click selection

`EonRenderer.#onPointerDown` treated _exactly two_ active pointers as the pinch transition and
everything else as the start of a drag. A third finger landing mid-pinch therefore became the drag
pointer with zero accumulated travel; the pinch path swallowed all its moves, so when it lifted,
`#onPointerUp` read it as a click and called `#selectAtScreen` — selecting whatever organism, or
deselecting whatever emptiness, happened to be under a finger the user had planted to steady a
zoom. Selection changes tear down follow and issue Worker queries, so a resting finger could
silently retarget the inspector.

The condition is now `size >= 2`: any extra finger makes the gesture a pinch, surrenders the drag
pointer, and can never end as a click. The browser pass reproduces the exact sequence (pinch, third
finger on empty space, lift all) and asserts the selection survives; on the shipped code the same
script showed the selection being cleared.

## 2. Defects (P2): the gesture after a pinch, and charts that block the sheet

Two adjacent touch problems, both fixed:

- **A pinch that ends with one finger still down left that finger dead** — `#dragPointerId` stayed
  null, so the surviving finger neither panned nor clicked until lifted and re-pressed. The
  standard map behaviour is that it continues as a pan. `#onPointerUp` now adopts the last
  remaining pointer as the drag pointer with its travel pre-spent past the click slop: it pans,
  and it can never read as a tap, because the gesture it belongs to was a pinch.
- **`.chart-plot { touch-action: none }` made the mobile stats sheet unscrollable** wherever a
  chart was under the finger — and the chart grid is most of the sheet's surface. The crosshair
  needs horizontal pointer moves, not vertical ones, so the rule is now `pan-y`: vertical swipes
  scroll the sheet, horizontal movement still drives the hover readout.

## 3. Defect (P2): the one-sheet rule did not survive becoming narrow

docs/06 §16 allows one major sheet at a time on a phone. The exclusivity was enforced only at
toggle time, but a viewport can become narrow with both panels already open — a tablet rotating, a
window shrinking — and then both rendered as stacked bottom sheets with the inspector hidden
beneath them. The review's browser pass confirmed it: shrink to 390 px with layers and stats open,
two sheets on screen.

The two booleans became one `PanelsOpen` state object — the rule is a joint constraint, and a
single reducer-style update can never leave two sheets open — and the media-query subscription
that tracks `narrow` now also settles the conflict on the way in (keep stats, close layers:
deterministic, and the stats sheet is the one whose running charts lose context when dismissed).
Same subscription, no extra effect, which also keeps the new `react-hooks` v7 set-state-in-effect
lint clean.

## 4. Polish (P3): a tooltip that could lie, ARIA on the radios, a leaked timer

- **Speed tooltips hardcoded the default rates** ("20 ticks per second", … "2000") instead of
  deriving them from `hostRuntime.targetTicksPerSecond1x`. A host paced differently would have
  buttons promising rates it never targets. Now computed as
  `SPEED_MULTIPLIER[speed] × targetTicksPerSecond1x` — the browser pass asserts the ×100 tooltip
  reads "2,000 ticks per second" from the real runtime config, and a unit test pins a
  non-default rate.
- **The layer radios carried `aria-pressed` alongside `role="radio"`/`aria-checked`.**
  `aria-pressed` belongs to toggle buttons and contradicts the radio role for assistive tech; the
  radios now expose `aria-checked` alone, and the stylesheet highlights `[aria-checked="true"]`
  the way it highlights pressed toggles.
- **The seed-copy confirmation timer was never cleared.** Two quick copies let the first click's
  timer cut the second confirmation short, and an unmount mid-confirmation left a timer firing
  into an unmounted component. The timer now lives in a ref, is cleared on re-click, and is
  cleared on unmount.

## 5. Examined and found clean

Beyond the table: the tiered `StatsHistory` promotion order (oldest merged once, ascending ticks
across tier boundaries, counters keep last-of-group), rate derivation across tier boundaries, the
skip of non-advancing ticks; `WorkerClient`'s fatal-error fan-out to all pending requests; the
render/vegetation buffer recycling paths including the destroyed-session and pre-renderer cases;
the pending-snapshot handoff (at most one held, older recycled); `spawnOrganism`'s scratch clear
being outside the hashed state; the temperature/capacity legend ranges published from the one
writer; `readSeedFromLocation`'s strict parses; and the host's debt reset on every speed change.
The three-plane → seven-plane terrain snapshot is validated end to end by `hostM7.test.ts` and the
protocol round-trip tests.

Two things were deliberately left alone: the per-frame linear entity scans (selection ring, follow,
detail promotion) — thousands of integer compares per frame, the M6-reviewed pattern, far below
particle update cost — and the inspector's raw `speciesId` row, which shows a real stored constant
with a Milestone 8 tooltip rather than an invented species.

## 6. Verification

`pnpm verify` green on this tree — typecheck, lint, 60 test files / 823 tests, build — including
the golden fixture, both 100 000-tick soak hashes and the Worker-vs-headless equivalence suite,
none of which this review's changes can touch and all of which were re-run anyway. The scripted
Chromium pass: 25/25 checks, zero console errors, zero page errors — and the same script run
against the pre-review renderer fails exactly the gesture check, with the selection visibly
changing under the third finger.
