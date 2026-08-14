# ADR 0013 — Milestone 8: Species and History

Status: accepted · Date: 2026-08-14 · Tasks: I01–I08 + E06 (docs/05 §§2–19, docs/06 §§12–14,
docs/08 §§22–23)

Versions: `ENGINE_VERSION` 0.5.0 → **0.6.0**, `SNAPSHOT_SCHEMA_VERSION` 6 → **7**,
`PROTOCOL_VERSION` 3 → **4**, `CONFIG_SCHEMA_VERSION` **unchanged at 6** (the species/history
config sections existed since 0.1.x and were already hashed). **Every golden hash regenerated**:
the canonical stream gained three sections (§6), and the initial world now carries a founder
species record and a `WorldCreated` event.

The critical property, verified before anything else: **the organism trajectory is unchanged from
0.5.0.** Phases 16 and 17 observe the world and write registry/event state; they never touch an
organism, a plant, a carcass or the PRNG. The regenerated 10 000-tick fixture reproduces 0.5.0's
population (4 364), generation (8), diet mean (−0.597) and death breakdown exactly; only the
hashes moved, because the hashed state grew.

## 0. Baseline verification

The Milestone 7 review head (`667167b`) reproduced `pnpm verify` green before any change was made
(typecheck, lint, 508 tests, build). The foundation-gate and Milestone 2.5 branches remain
unmerged (ADR 0006 §0, deadline unchanged: before J05 / Milestone 9).

## 1. The trait vector is phenotype-space, versioned, and excludes what docs exclude

`evolution/traitVector.ts` implements docs/05 §3's fifteen dimensions in the docs' order, each
normalized to `[0, Q]` by explicit per-dimension ranges derived from the config
(`TRAIT_VECTOR_VERSION = 1`). Two choices worth recording:

- **Effective values, not gene values**, where the docs name effective ones: dimension 1 is speed
  after the armor penalty and dimension 3 is turn after the size penalty, with normalization
  floors set to the smallest effective value any genome can produce, so the whole band stays
  reachable. Clustering therefore sees what ecology sees.
- **Hue and brain weights contribute nothing** (docs/05 §3). A test pins that two organisms
  differing only in hue have distance exactly zero.

Distance is docs/05 §4's equal-weight squared form kept as a raw `ΣΔ²`; thresholds are compared as
`ΣΔ² ≥ t²·15` (`rmsThresholdSumSq`), so no comparison ever divides and truncates.

## 2. Deterministic 2-means, and the one config rule it needed

`evolution/speciation.ts` follows docs/05 §7 to the letter: seed A = lowest entity ID, B =
farthest from A (tie → lowest ID), A2 = farthest from B (tie → lowest ID), centroids initialize to
(A2, B), exactly `kMeansIterations` assign/recompute rounds with ties to cluster A and integer
centroid means, empty cluster ⇒ fail. Candidate conditions: both daughters ≥
`minDaughterPopulation` and centroid distance ≥ `splitDistanceThresholdQ`. Stability: a candidate
must qualify at `stabilityIntervals` CONSECUTIVE analyses with centroids continuous under the
docs' A/B-swap comparison; **any non-qualifying analysis resets the candidate to nothing** (the
docs' recommended v0.1 policy, including when the species falls below the `2 × minDaughter`
analysis floor).

The swap comparison is only unambiguous if a new centroid can never sit within continuity range of
BOTH stored centroids. That is a config-space property, so it became a validator rule:
`splitDistanceThresholdQ > 2 × candidateCentroidContinuityThresholdQ` (defaults 901 > 656 hold).
The previous weaker rule (`continuity < split`) allowed ambiguous configurations.

Split execution: children are created cluster-A-first (deterministic IDs), each child's founder is
its cluster's lowest entity ID, members are reassigned in gather order, the parent ends with
reason `split` and population 0, and one `SpeciesSplit` event is emitted. Children start with
zeroed lifetime counters: per-species accumulators mean "while a member of THIS species", which is
what makes per-species diet fractions meaningful (docs/05 §15).

Species created during an analysis pass are not analyzed until the next interval — the loop bound
is captured at phase entry.

## 3. Membership is counted where it changes, extinction where it happens

`organisms.speciesId` stays the authoritative assignment. The registry's population is maintained
incrementally at the three places membership changes — spawn (`recordBirth`), death finalization
(`recordDeath`), split reassignment — so the docs/07 §4 "species population matches members"
invariant is never reconstructed, only asserted (phase 16 asserts it per species per analysis; the
100 000-tick soak sweeps it every 997 ticks).

Extinction is marked by **death finalization, at the exact tick the last member dies**
(docs/05 §8), not discovered late by the next scheduled analysis. A parent ended by split is not
extinct, exactly as the docs require; ended records are permanent.

Kill credit and the `FirstPredation` report happen in combat resolution (phase 11), where both
bodies still have live rows whatever order phase 13 will release them in — the mutual-kill case
that would otherwise read a cleared row.

## 4. Events: one emission site per fact, spam impossible by construction

`history/EventStore.ts` is an append-only log of numeric-only records (id, tick, type, severity,
species/entity IDs, flattened optional region, versioned numeric payload), bounded by
`limits.maxTimelineEventsInMemoryBeforeChunk`; overflow drops the OLDEST and counts them
(`droppedEventCount`), so the present edge of the timeline never degrades. Detection never reads
the log — detector state lives in `EventDetectors` — so dropping old events cannot change future
events.

Per-type spam control (docs/05 §§13–17):

- `WorldCreated` — once, at construction.
- `SpeciesSplit` / `SpeciesExtinct` — structural, once per fact.
- `FirstPredation` — a latched world-first (major severity), attacker/victim/species/position
  captured at the kill.
- `CarnivoreLineageDetected` — once per species ever, on `CARNIVORE_PERSIST_SAMPLES = 5`
  consecutive qualifying samples of OBSERVED intake (never the diet gene); an interval with less
  than `CARNIVORE_MIN_INTERVAL_ENERGY` intake neither grows nor resets the streak ("adequate food
  observations"). The world's first carnivore lineage is major, later ones notable.
- `PopulationBoom`/`PopulationCrash` — rolling 10-sample baseline, relative thresholds from
  config plus `POPULATION_EVENT_MIN_ABS_DELTA = 32` absolute, judged only after a full baseline
  window, sharing one `eventCooldownStatsSamples` debounce.
- `MassExtinction` — ≥ 40 % of the species active at the window start going extinct inside
  `MASS_EXTINCTION_WINDOW_SAMPLES = 20` samples, minimum 8 starting species; after firing, the
  next window must START after the event, so overlapping windows cannot re-report the same
  catastrophe. Affected species IDs are capped at 32 with the true count in the payload.
- `PopulationCapReached` (closes task E06) — one event per pressure EPISODE: emitted when
  rejections grow while no episode is active; a full statistics interval without a rejected birth
  ends the episode.

The handful of detector constants the docs describe but the config schema does not carry
(`POPULATION_BASELINE_WINDOW_SAMPLES`, `POPULATION_EVENT_MIN_ABS_DELTA`,
`MASS_EXTINCTION_WINDOW_SAMPLES`, `CARNIVORE_PERSIST_SAMPLES`, `CARNIVORE_MIN_INTERVAL_ENERGY`,
`MASS_EXTINCTION_MAX_LISTED_SPECIES`) are named engine constants versioned by `ENGINE_VERSION` —
adding config fields would have bumped `CONFIG_SCHEMA_VERSION` for values docs/08 §23 never
listed.

## 5. Statistics: authoritative detectors, derived series

Phase 17 (every `statisticsInterval` ticks) assembles the docs/05 §10 world sample and per-species
samples in pure integer math and pushes them into `history/StatisticsStore.ts`: three tiers of 240
buckets aggregating 10:1 (mean for levels, sum for interval counters, last for cumulative
levels — the same interpretation the M7 review accepted for the UI's `StatsHistory`), plus one
120-sample ring per species that freezes when the species ends. Total memory is fixed for the
world series and ~5 KB per species ever created.

The split that keeps hashes honest (docs/02 §9):

- **Hashed + serialized**: the species registry (with candidate state and the per-species
  carnivore-detector fields), the event log, and `EventDetectors` — everything that influences
  future events or future splits.
- **Serialized, deliberately NOT hashed**: the statistics time series. It is derived history — a
  pure record of past authoritative states that nothing reads back into simulation or detection —
  and its retention shape is presentation capacity. Hashing it would make golden hashes move when
  a chart's retention is tuned, the exact coupling the host-runtime split (ADR 0002 §4) exists to
  prevent. The risk of the non-hashed path drifting is pinned by tests instead: byte-exact
  capture/restore round-trip, and byte-equality of the full stats capture between a continuous
  run and a snapshot/restore run continued to the same tick.

## 6. Hash and snapshot surface

Canonical stream 0.6.0 appends, after carcasses: **species registry** (records with candidate
state), **event log** (with next ID and dropped count), **detector state**. Snapshot schema 7 adds
`species` and `history { events, detectors, stats }`. Restore cross-validates the registry against
the restored population (every live organism's species exists and is active; every record's
population equals its live member count) and rejects corrupt snapshots with typed errors.

Continuous-vs-restored equality is pinned mid-candidate: save at tick 120 with a split three
analyses deep, restore, run both to 400 — identical split tick, identical event log entry for
entry, identical state hashes, byte-identical statistics captures.

## 7. Protocol 4 and the pull-based UI

Three request/response pairs (`QUERY_SPECIES` → `SPECIES_DETAILS`, `REQUEST_TREE` →
`TREE_SNAPSHOT`, `REQUEST_HISTORY_RANGE` → `HISTORY_EVENTS`) and four telemetry fields
(`activeSpeciesCount`, `totalSpeciesCount`, `extinctSpeciesCount`, `latestEventId`). There is
deliberately **no event push stream**: telemetry is the change signal, and the session pulls
`eventsSince(lastSeenId)` when `latestEventId` advances, refreshes the selected species at
telemetry cadence (the organism-inspector pattern), and refreshes the tree when the species set
changes or continuously while a species/tree panel is open. Every list the UI holds is bounded
(the client event accumulation mirrors the engine's own cap).

Engine → DTO conversion happens in the Worker host, the one module that imports both packages:
Q fractions become unit fractions, positions become location units, and the engine's label arrays
(event types, severities, end reasons, trait dimensions) ride `WorldDisplayDto` so the UI captions
numbers without an engine dependency.

## 8. UI: species panel, Tree of Life, history timeline

- **Species panel** (docs/06 §12): living/ended list, inspector with status, origin, parent and
  daughter links, population, founder, births/deaths/kills, observed diet fractions, live mean
  age/energy, pending-split progress ("3 / 5 analyses"), population and mean-size/speed/diet
  charts from the engine-side series, and the fifteen-dimension centroid as bars with the origin
  value notched — drift is visible per dimension. The header tooltip states the docs/05 §2
  honesty: detected morphospecies, not reproductive isolation.
- **Tree of Life** (docs/06 §14): plain SVG; recursive layout (leaves in registry order, split
  parents centred between daughters); life-bars from origin to end/now; year axis; zoom buttons
  with native scroll as pan. Status is distinguished beyond colour: living bars end in an
  arrowhead, extinct in a cross, splits in the branch connector, origins in a notch. Node click
  selects the species; selection highlights in both tree and panel.
- **History timeline** (docs/06 §13): a marker strip on the authoritative time axis (severity =
  height/colour) plus a reverse-chronological list with severity filtering; events expand to
  their species links, organisms and location. No rewind — dragging time to travel is
  Milestone 11.
- The top-bar species placeholder became the live active-species count (the M7 test that pinned
  the placeholder now pins its absence), and the organism inspector's species row links into the
  species inspector.
- Panel state generalized to one `Record<PanelId, boolean>` with a priority rule for the
  narrow-viewport one-sheet constraint (the ADR 0012 fix, now over five panels); the three new
  panels join the bottom-sheet media query.

Browser-verified (headless Chromium, 1440×900, built bundle): 15/15 checks — species stat live,
panel lists and inspects Species 0001 with three charts, tree draws and selects, toggles close,
timeline lists `worldCreated` (and caught a real `PopulationBoom` while running at 100×), zero
console/page errors.

## 9. What 100 000 ticks of real evolution says

The regenerated populated soak ends with **one species** after 100k ticks (population 845, seven
events, all boom/crash/cap-episode plus WorldCreated). That is the correct answer, not a failure:
the founder lineage's evolved diversity is a continuous cloud, and docs/05 §7's detector exists
precisely to refuse to split clouds. The synthetic fixtures prove the other direction (real
bimodality splits after exactly five stable analyses). Whether the default constants allow real
ecological bimodality to EMERGE at realistic horizons joins the ADR 0006 §7 / ADR 0008 §5
calibration questions for **L07** — docs/07 §12 lists "species never splitting" as a failure mode
to monitor there.

Costs, measured: the 10 000-tick fixture went from ~116 s to ~116 s (species analysis every 400
ticks over ≤ 8 192 organisms and statistics every 100 ticks are noise against sensing); the
100 000-tick soak reproduced at 460 s wall (previous baseline ~1 810 s standalone on the M5
machine — different container, not comparable; the invariant sweep now includes the species
registry).

## 10. Carried forward

1. Foundation-gate and M2.5 branches still unmerged; deadline before J05 / Milestone 9
   (ADR 0006 §0).
2. L07 calibration now also owns: can real divergence emerge on default constants (this ADR §9),
   alongside the population-cap and carcass-cap findings.
3. The E06 checkbox closes; `PopulationCapReached` events exist. The soak world emits its first
   one the moment it pins the 8 192 cap — visible in the timeline immediately.
4. Species naming is the docs/05 §9 numeric fallback; generated cosmetic names are post-core.
5. "Focus members" from the docs/06 §12 species-inspector list is deferred: it needs a
   member-position query the protocol does not carry yet; every other listed field shipped.
