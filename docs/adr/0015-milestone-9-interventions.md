# ADR 0015 — Milestone 9: Player Interventions and the Authoritative Command Log

Status: accepted · Date: 2026-08-14 · Tasks: J01–J08 (docs/01 §4, docs/02 §§15–16, docs/03 §25,
docs/06 §10) plus the pre-J05 foundation-gate merge mandate (ADR 0006 §0, ADR 0008 §0,
ADR 0010 §0, ADR 0013 §10)

Versions: `ENGINE_VERSION` 0.6.0 → **0.7.0**, `SNAPSHOT_SCHEMA_VERSION` 7 → **8**,
`CONFIG_SCHEMA_VERSION` 6 → **7**, `PROTOCOL_VERSION` 4 → **5**, new `COMMAND_SCHEMA_VERSION`
= **1**. **Every golden hash regenerated**: the canonical stream gained the founder region and the
command log, event payloads became signed 32-bit words, the config gained the `interventions`
section — and the mandatory fixture now RUNS a fixed nine-command log, so its trajectory
legitimately diverges from 0.6.0 once the first command applies at tick 50.

The core contract, stated once: **the UI never modifies authoritative state.** Player input
becomes an immutable, versioned, quantized, `(tick, sequence)`-ordered command; commands apply
only in phase 0 of the tick they target; the whole log — applied history, pending suffix and
cursor — is hashed and serialized. Same seed + config + canonical command stream ⇒ identical
state, which is what Milestones 10–11 (persistence, replay, branching) stand on.

## 0. The pre-J05 merge mandate, closed

Four consecutive ADRs carried the same deadline: merge the foundation-gate
(`claude/evosim-project-setup-ps3fry`, tip `73adfa7`) and Milestone 2.5
(`claude/m2-5-review-visualizer-54i8qn`, tip `1083172`) lines "before J05 / Milestone 9". A
textual `git merge` was checked and rejected: both branches fork from the Milestone 2 commit
`8aac47b`, nine milestones behind this line, and nearly every file they touch has since been
rewritten (two independent `ENGINE_VERSION` histories, two conflicting `docs/adr/0004-*.md`
files, a debug web view superseded by the real renderer). The union the mandate actually wanted —
"take the union of both hash-stream changes, bump ENGINE_VERSION once, regenerate every golden" —
was performed **semantically**, fix by fix, with `foundationGate.test.ts` pinning each one:

| Foundation-gate fix (its ADR §)                                         | Disposition in this line                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §1 writable public `EnvironmentStore`                                   | Ported, adapted: the store instance is frozen (no array swap, no field injection) and the global temperature offset became a private field behind a getter and an engine-internal setter. Element writes through a cast remain possible — exactly as they did in the foundation-gate's own version ("stated honestly"); the boundary that holds is the type surface, the lint rule, and the fact that every out-of-process consumer sees copies. |
| §2 `fromSnapshot` regenerated and discarded the world                   | Ported: a module-private Symbol-guarded restore channel skips generation entirely and adopts the snapshot's environment, founder region and (newly stored) `generationAttempt`. A save whose config can no longer generate any world now loads — pinned by a test that makes `createWorld` impossible and restores anyway. Mattered now, not before: terrain EDITS make "regenerate and overwrite" actively wrong rather than wasteful.          |
| §3 founder region unhashed                                              | Ported: hashed as four words after the environment arrays. On restore the SAVED region is the truth, so two states differing only there must differ.                                                                                                                                                                                                                                                                                             |
| §4 unknown config fields entered the world hash                         | Ported verbatim (template = `DEFAULT_CONFIG`): unknown fields, missing fields and host-runtime values pasted into the authoritative config all fail construction — which the new `interventions` section made urgent again.                                                                                                                                                                                                                      |
| §5 snapshot lengths validated but not values                            | Ported, extended: field ranges, biome enum, growth carry < Q, founder-region internal consistency — and the biomass ceiling is the M9 overfill bound (`capacity × biomassOverfillLimitQ`), because a snapshot saved right after an ADD_BIOMASS stroke is a legitimate world.                                                                                                                                                                     |
| §6 unbounded world geometry                                             | Ported: `envGridSize ≤ 4096`, `sizeLU ≤ ⌊(2³¹−1)/POS_SCALE⌋`.                                                                                                                                                                                                                                                                                                                                                                                    |
| §7 smaller: `deepCloneJson` `__proto__`; dead noise salts; magic `4096` | All ported: own-property define in the clone (with a pollution test), `elevationOctave1/2` removed, `getMoistureQ` uses `Q`.                                                                                                                                                                                                                                                                                                                     |

Milestone 2.5's debug visualizer is **superseded, not merged**: its biome palette was already
reused verbatim by the M6 renderer (ADR 0010 noted this was deliberate), its field views became
the M7 layer system (H05), and its environment-only hash helper is covered by the full canonical
hash plus the terrain snapshot writers. Nothing in that branch fixes anything this line lacks.
Both branches remain in the repository untouched for the record.

## 1. Command identity: engine-stamped, totally ordered, forge-proof by construction

A command's identity is `(schemaVersion, id, tick, sequence)` (docs/02 §15). The engine assigns
`id` and `sequence` itself at acceptance — both monotonic from 1 in acceptance order — and stamps
`tick` as the next executable tick unless the input carries an explicit future `targetTick`
(fixtures, scripted experiments). Application order is `(tick, sequence)` lexicographic.

That one design choice — the engine stamps, the UI never does — is what makes the docs' required
edge cases _unrepresentable_ rather than merely handled in the live path, and deterministically
rejected everywhere else:

- **Duplicate IDs / duplicate sequences** cannot be issued live; on the restore path both are
  typed `CommandLogSnapshotError`s, along with any `(tick, sequence)` disorder.
- **Late / past-tick commands**: an explicit `targetTick` earlier than the next executable tick is
  rejected as `PastTick` — an answer, not an exception. On restore, an applied command at or after
  the snapshot tick, or a pending command before it, is a typed error: the first would re-apply
  history, the second could never apply.
- **Malformed / out-of-bounds commands** are rejected with `Malformed` / `OutOfBounds` and a
  human-readable detail. Rejection provably perturbs nothing (hash-equality test).

The log itself is append-only and immutable (records frozen at acceptance), keeps applied history
AND the pending suffix, and hashes its counters, cursor and every command. Milestone 10 will chunk
history to storage; nothing is ever dropped here, because dropping would break replay.

## 2. Phase 0 and the appliers: one write path, no PRNG, explicit cell order

`applyCommandsForTick` is phase 0 of docs/03 §7, exactly as reserved since Milestone 1. Appliers
are pure integer math and **never draw from the PRNG** — an intervention perturbs the world where
it lands and leaves the random stream untouched. Effects per docs/03 §25:

- **Global temperature**: absolute offset set (bounded), then a whole-grid recompute.
- **Brushes** (temperature/moisture/fertility/terrain up/down/biomass add/remove): affected cells
  are visited row-major over the stroke's bounding box; each cell receives **at most one
  application per command**, scaled by the strongest falloff factor any sample projects onto it
  (max is order-free). A stroke is one band-shaped intervention, not a pile of overlapping stamps:
  its per-cell effect is bounded by its strength however densely the pointer sampled. Falloff is
  `hard` or `linear` (integer `isqrt`, half-LU lattice so cell centres stay integral). Temperature
  offsets saturate at a config bound; moisture offsets clamp to ±Q; fertility and elevation clamp
  to [0, Q]; ADD_BIOMASS respects the docs/03 §27 transient overfill (≤ `biomassOverfillLimitQ` ×
  capacity, nothing onto zero-capacity cells, decays at the next environment update — the growth
  step already snaps overfull cells back to capacity).
- **Meteor**: linear radial falloff from the impact point for all four effects — organism health
  damage (default 2.0 health bars at the centre, so the inner half-radius is lethal and the rim
  wounds), plant biomass loss, terrain depression, fertility scorch. Organisms are iterated in
  ascending slot order (damage is independent per organism); a body reaching zero health is marked
  with `DeathCause.Meteor` (reserved since M3) and finishes its tick like every doomed organism —
  phase 13 leaves a carcass where it stood. No scripted deletion, no randomness.

**Dependent recompute** (docs/03 §19, docs/10 §5): climate/terrain edits re-derive biome, plant
capacity and passability for the touched region through `recomputeDerivedRegion`, which runs
EXACTLY the generation pipeline over effective (base + offset) values — a parity test recomputes a
pristine world and asserts the hash unchanged. Lowering land below sea level genuinely floods it
(water biome, impassable, plants zeroed, organisms NOT deleted — the water rules take over, and
the fixture world records 26 drowning deaths from one stroke); raising a shallow drains it.
Biomass edits recompute nothing — biomass is not a classification input.

**Timeline (J08)**: each applied command appends exactly one `PlayerIntervention` event (type 9,
reserved since M8) — Notable for tools, Major for the meteor — carrying the enclosing region and
`[kind, commandId, …]` in the payload, so the UI timeline names the tool and can cross-reference
the immutable log. Event payloads are now signed 32-bit integers by contract (asserted at append,
validated at restore): a cooling brush legitimately logs a negative strength, which the previous
non-negative hashing rejected.

## 3. Stroke canonicalization (J02): device event rate dies at the boundary

`resampleStroke` lives in `@eon/protocol` — pure math, versioned with the wire contract whose
meaning it defines. Pointer paths (float world coordinates) are resampled at fixed world-distance
spacing (`brushSampleSpacingLU`, default 8 LU of ARC length along the polyline), the endpoint is
kept, every sample is quantized to whole LU, consecutive duplicates are dropped, and the sample
count is capped (truncation reported). Tests pin that the same straight stroke sampled at 2, 17
and 500 pointer events canonicalizes identically, and a quarter-circle at 60/240/960 events
likewise — the docs' "identical where appropriate", with the 0.5 LU quantization margin as the
precise meaning of "appropriate". A click canonicalizes to one sample.

The renderer collects the raw path (tool capture mode: one-pointer drag paints instead of panning,
click-select is suppressed, a brush ring in screen space follows the cursor; pinch and wheel keep
working, and a pinch cancels a stroke). The session canonicalizes and sends `QUEUE_COMMAND`; the
worker host converts wire names to engine kinds and answers `COMMAND_RESULT` with the stamped
identity or the rejection. The UI's tool bounds come from `WorldDisplayDto.interventions`, copied
verbatim from the authoritative config by the host, so a slider can never promise a value the
engine would reject.

## 4. Protocol 5 and the paused-world honesty

`QUEUE_COMMAND` → `COMMAND_RESULT` (request/response, structural decode only — VALUE judgements
are the engine's, returned as deterministic rejections so a slider bug becomes a readable toast,
never a dead message). `TERRAIN_SNAPSHOT` re-ships the packed terrain planes whenever the host's
per-slice cursor check sees a command applied — terrain stopped being static the moment the player
could flood it, and a no-intervention world never re-sends a byte. `TelemetryDto` gains
`pendingCommandCount`: a command queued on a paused world is accepted but APPLIES on the next
executed tick, and the UI says "queued — applies when the simulation runs" instead of pretending.
The tools panel joins the one-sheet mobile rule (highest keep priority); Esc leaves tool mode
before it clears selection.

## 5. The fixture now carries commands, and what its world says

CLAUDE.md's mandatory fixture always read "seed + config + **commands: fixed fixture log**"; the
log existed as an empty array since Milestone 1. It is now nine commands — one of every kind,
spread over ticks 50–5000, aimed at the fixture world's founder region — stored in
`fixtureCommands.ts`, mirrored into `goldenStateHashes.json` (a test pins the two equal), queued
by the golden test and by `pnpm headless --fixture-commands`. Every applier is inside the golden
regression net; a change to any of them moves the 10 000-tick hash.

What the fixture world records, for the changelog: population 4 381 at tick 10 000 (0.6.0: 4 364),
26 drowning deaths from the LOWER_TERRAIN stroke flooding founder-adjacent lowland, a meteor
crater at the founder centre at tick 5 000 — which wounds but kills nobody, because by tick 5 000
the population has grazed the centre bare and dispersed; the lethal-core mechanics are pinned by
unit tests instead. Tick 0/1 hashes differ from 0.6.0 only through the hash-stream and config
changes; the organism trajectory is bit-identical until the first command applies at tick 50
(verified: the no-command engine at 0.7.0 reproduces 0.6.0's population/generation/diet exactly,
and rejected commands leave the hash untouched).

## 6. Hash and snapshot surface

Canonical stream 0.7.0: founder region (four words) after the environment arrays; command log
(counters, cursor, every command) after the detectors; event payloads as signed words. Snapshot
schema 8 adds `generationAttempt` and `commands` (with cursor); restore validates both against
the restored tick. Continuous-vs-restored equality is pinned mid-history — save with one command
applied and one pending, restore, run both to the horizon, identical hashes — plus a value-level
proof that an applied fertility brush does not re-apply on load (additive field, so a double
application would be visible as +strength).

Replay (docs/06 §24 primitive): a fresh engine fed the RECORDED canonical commands at their
recorded ticks reproduces the live session's final hash, its event log entry for entry, and its
command log byte for byte. This is the mechanism Milestone 11 will drive from snapshots.

## 7. Costs, measured

The 10 000-tick fixture: ~112 s in this container (was ~116 s at 0.6.0 in ADR 0013's container) —
phase 0 with an empty queue is one integer compare per tick, and the nine fixture commands are
noise. The 100 000-tick lifeless environment soak reproduces at ~103 s. Worst-case command cost is
bounded by config: ≤ 64 samples × the stroke bounding box for brushes (cold path, player-rate),
one whole-grid recompute for the global offset (65 536 cells, well under a millisecond of integer
work), one full-slot scan for the meteor.

## 8. Carried forward

1. **J09 translocation stays open as designed**: docs/01 §4 and docs/02 §15 both mark it
   "late-MVP if schedule permits" and never specify its payload; building it would have meant
   inventing scope inside a determinism milestone.
2. L07 calibration questions unchanged (population cap, carcass cap, carnivory horizon, split
   emergence — ADR 0006 §7, ADR 0008 §5, ADR 0013 §9).
3. The suite-cost note (ADR 0006 §9, ADR 0010 §3) unchanged: two 100k soaks per `pnpm test`.
4. Milestone 10 will move command history chunking to storage; the in-memory log is the history
   until then, uncapped by design (dropping commands would break replay).
5. The repository default branch still points at the Milestone 2 feature branch (ADR 0010 §1's
   outstanding cleanup) — an owner decision, unchanged by this milestone.
